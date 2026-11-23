// DubSession orchestrator: pipeline → prefetch → scheduler; status events (§5). Owner: C.
import type { DubErrorCode, DubStatus, EngineId, Feedback, Gender, Lang, Line, Plan, Settings, VoiceInfo } from '../shared/types';
import { DubError } from '../shared/types';
import { STORAGE_KEYS } from '../shared/settings';
import { getLines as realGetLines } from './pipeline';
import type { GetLinesOptions } from './pipeline';
import { getTranslatorGlobal } from './translate-local';
import { LANG_INFO } from '../shared/settings';
import { bridgeRequest, getPlayer, getVideo, restoreOfficialAudio as realRestoreOfficialAudio, switchToOfficialAudio as realSwitchToOfficialAudio } from './yt';
import type { OfficialAudioResult } from './yt';
import { warmUpNano as realWarmUpNano } from './text/nano';
import { createEngine as realCreateEngine } from './voice/engine';
import type { PlayEnd, PlayHandle, Prepared, TtsEngine } from './voice/engine';
import { listVoices as realListVoices, pickBestVoice as realPickBestVoice, pickVoiceFor as realPickVoiceFor, resetVoiceChoices as realResetVoiceChoices } from './voice/voices';
import type { AudioEngineOptions } from './voice/audio';
import { fit, estimateMs, planTrack, VoiceCalibration, loadVoiceCal as realLoadVoiceCal, saveVoiceCal as realSaveVoiceCal } from './sync/fit';
import type { Calibration, PacedPlan, VoiceCalEntry } from './sync/fit';
import { Scheduler } from './sync/scheduler';
import type { Clock, Speaker } from './sync/scheduler';
import { PlayerWatcher } from './sync/player';
import { SpeakerPitch, captionGender } from './sync/pitch';
import type { SpeechMeasure } from './voice/webspeech';

/** Pre-generate audio this far ahead (s). */
export const PREFETCH_S = 30;
/** Max concurrent prepare() calls. */
export const PREFETCH_CONCURRENCY = 3;
/** Continuous mode: lines are skipped only beyond this lag (ms); a smooth lag controller keeps it far lower. */
export const CONTINUOUS_MAX_LAG_MS = 6000;
const STATS_MAX = 50;

/** Injectable collaborators (tests); defaults are the real modules. */
export interface DubSessionDeps {
  getLines: (videoId: string, lang: Lang, onProgress?: (m: string) => void, opts?: GetLinesOptions) => Promise<Line[]>;
  /** Start the on-device translator download inside the click (user activation). */
  warmUpTranslator: (to: Lang, onProgress?: (pct: number) => void) => void;
  createEngine: (id: EngineId, opts?: AudioEngineOptions) => TtsEngine;
  pickVoiceFor: (lang: Lang, gender: Gender, engine?: EngineId, preferredId?: string) => Promise<VoiceInfo | null>;
  pickBestVoice: (lang: Lang, engine?: EngineId, preferredId?: string) => Promise<VoiceInfo | null>;
  resetVoiceChoices: () => void;
  listVoices: (lang: Lang, engine?: EngineId) => Promise<VoiceInfo[]>;
  createPitch: (video: HTMLVideoElement) => SpeakerPitch;
  /** Wall clock (ms) for time-to-first-line. */
  now: () => number;
  /** Store a time-to-first-line sample. */
  saveStat: (s: FirstLineStat) => Promise<void> | void;
  /** Per-voice speed calibration (chrome.storage.local 'voiceCal'). */
  loadVoiceCal: () => Promise<Record<string, VoiceCalEntry>>;
  saveVoiceCal: (cal: VoiceCalibration) => Promise<void> | void;
  /** v1.1 (F): start the Gemini Nano download inside the click (smartFrench). */
  warmUpNano: () => void;
  /** v1.1 (F): switch to YouTube's own target-language audio track; null/!switched = dub normally. */
  switchOfficialAudio: (videoId: string, lang: Lang) => Promise<OfficialAudioResult | null>;
  restoreOfficialAudio: (videoId: string) => void;
}

export interface FirstLineStat { videoId: string; lang: Lang; engine: EngineId; ms: number; at: number }

export interface DubSessionOptions {
  videoId: string;
  settings: Settings;
  video?: HTMLVideoElement;
  player?: HTMLElement | null;
  deps?: Partial<DubSessionDeps>;
  /** Toasts for the player UI (engine fallback, ad pause…). */
  onToast?: (message: string, kind?: 'info' | 'warn' | 'error') => void;
  /** Line started (text) or ended (null) — subtitles overlay. */
  onLine?: (line: Line | null) => void;
}

interface LineInfo { rate: number; overflowMs: number }

/** One dub run for one video. Created when the user turns dub on; stop() restores everything. */
export class DubSession {
  readonly videoId: string;
  private settings: Settings;
  private readonly opts: DubSessionOptions;
  private readonly d: DubSessionDeps;
  private status: DubStatus;
  private readonly listeners = new Set<(s: DubStatus) => void>();
  private token = 0;
  private active = false;

  private video: HTMLVideoElement | null = null;
  private watcher: PlayerWatcher | null = null;
  private pitch: SpeakerPitch | null = null;
  private scheduler: Scheduler | null = null;
  private engine: TtsEngine | null = null;
  private engineId: EngineId = 'webspeech';
  private lines: Line[] = [];
  private prepared = new Map<string, Promise<Prepared>>();
  private ready = new Map<string, Prepared>();
  private inflight = 0;
  private pumpTimer: ReturnType<typeof setInterval> | null = null;
  private voiceByGender = new Map<Gender, string | undefined>();
  private cal: Calibration = {};
  private t0 = 0;
  private firstLineDone = false;
  private current: Line | null = null;
  private lineInfo = new Map<string, LineInfo>();
  private fallingBack = false;
  private lineIndex = new Map<string, number>();
  /** Per-voice speed factors (persisted per voice id). */
  private vcal = new VoiceCalibration();
  private calSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Speaker evidence has been read for lines ending at or before this media time. */
  private observedT = -Infinity;
  /** v1.1: we switched YouTube's audio track; restore it on stop. */
  private officialAudio = false;

  constructor(opts: DubSessionOptions) {
    this.opts = opts;
    this.videoId = opts.videoId;
    this.settings = { ...opts.settings, voiceByLang: { ...opts.settings.voiceByLang } };
    this.status = { state: 'idle', videoId: opts.videoId };
    this.d = {
      getLines: realGetLines,
      createEngine: realCreateEngine,
      pickVoiceFor: realPickVoiceFor,
      pickBestVoice: realPickBestVoice,
      listVoices: realListVoices,
      warmUpTranslator,
      resetVoiceChoices: realResetVoiceChoices,
      createPitch: (v) => new SpeakerPitch(v),
      now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
      saveStat: saveFirstLineStat,
      loadVoiceCal: realLoadVoiceCal,
      saveVoiceCal: realSaveVoiceCal,
      warmUpNano: realWarmUpNano,
      switchOfficialAudio: realSwitchToOfficialAudio,
      restoreOfficialAudio: realRestoreOfficialAudio,
      ...(opts.deps ?? {}),
    };
    this.cal = { voiceSpeed: this.settings.voiceSpeed };
  }

  /** Run pipeline, prefetch 30 s ahead, start the scheduler. Resolves when dubbing starts or errors (status reflects which). */
  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    const token = ++this.token;
    const alive = () => this.active && token === this.token;
    this.t0 = this.d.now();
    this.firstLineDone = false;
    this.fallingBack = false;
    const lang = this.settings.targetLang;
    this.setStatus({ state: 'preparing', videoId: this.videoId });

    const video = this.opts.video ?? getVideo();
    if (!video) return this.fail('NOT_WATCH_PAGE', 'No video player on this page');
    this.video = video;
    const player = this.opts.player !== undefined ? this.opts.player : getPlayer();

    // WebAudio must be created inside the user's click: do it before the first await.
    let pitchReady: Promise<boolean> = Promise.resolve(false);
    if (this.settings.matchSpeakerGender) {
      try {
        this.pitch = this.d.createPitch(video);
        pitchReady = this.pitch.startAsync();
      } catch {
        this.pitch = null;
      }
    }

    // Translator.create() for a model download needs the click's transient activation: call it now.
    try {
      this.d.warmUpTranslator(lang, (pct) => {
        if (alive() && this.status.state === 'preparing') this.setStatus({ ...this.status, message: `Downloading ${LANG_INFO[lang].name} translator… ${pct}%` });
      });
    } catch { /* optional */ }
    if (this.settings.smartFrench && lang === 'fr') {
      try { this.d.warmUpNano(); } catch { /* optional */ }
    }

    // v1.1: YouTube's own French (official / auto-dub) audio track beats any TTS — switch to it, no dub.
    if (this.settings.preferOfficialAudio) {
      let r: OfficialAudioResult | null = null;
      try { r = await this.d.switchOfficialAudio(this.videoId, lang); } catch { r = null; }
      if (!alive()) return;
      if (r?.switched) {
        this.officialAudio = !r.already;
        try { this.pitch?.stop(); } catch { /* ignore */ }
        this.pitch = null;
        this.setStatus({
          state: 'dubbing', videoId: this.videoId, officialTrackLang: lang, usingOfficialAudio: true,
          message: `Using YouTube's official ${LANG_INFO[lang].name} audio`,
        });
        return;
      }
    }

    this.watcher = new PlayerWatcher(video, player, {
      onPause: () => this.scheduler?.pause(),
      onPlay: () => this.scheduler?.resume(),
      onSeeking: (t) => { this.scheduler?.seek(t); this.observedT = t; },
      onSeeked: (t) => { this.scheduler?.seek(t); this.observedT = t; this.pump(t); },
      onRateChange: () => this.scheduler?.rateChanged(),
      onAdStart: () => this.onAdStart(),
      onAdEnd: () => this.onAdEnd(),
    });
    this.watcher.setDuckLevel(this.settings.duckLevel);
    this.watcher.start();

    let lines: Line[];
    try {
      lines = await this.d.getLines(this.videoId, lang, (message) => {
        if (alive() && this.status.state === 'preparing') this.setStatus({ ...this.status, message });
      }, {
        fromTime: video.currentTime || 0,
        // Progressive mode: first ~40 lines resolve, the rest stream in here.
        onUpdate: (all) => { if (alive()) this.applyLines(all); },
        smartFrench: this.settings.smartFrench,
        isAlive: alive,
      });
    } catch (e) {
      if (!alive()) return;
      return this.failFrom(e, 'NO_CAPTIONS');
    }
    if (!alive()) return;
    if (!lines.length) return this.fail('NO_CAPTIONS', 'This video has no usable captions');
    this.applyLines(lines);

    // Engine + voices.
    try {
      // v1.1.1: French uses the free neural voice (Siwis, owner's pick) by default, even if the popup was never opened.
      const eng = this.settings.engine === 'webspeech' && this.settings.preferNeural && this.settings.targetLang === 'fr' ? 'neural' : this.settings.engine;
      this.setEngine(eng);
    } catch (e) {
      if (this.settings.engine === 'webspeech') return this.failFrom(e, 'ENGINE_ERROR');
      this.toast('Voice service unavailable — using the free browser voice', 'warn');
      try { this.setEngine('webspeech'); } catch (e2) { return this.failFrom(e2, 'ENGINE_ERROR'); }
    }
    const ok = await this.resolveVoices();
    if (!alive()) return;
    if (!ok) return this.fail('NO_VOICE', `No ${lang} voice installed. Add one in System Settings → Accessibility → Spoken Content → System voice → Manage voices.`);

    // Per-voice speed calibration from earlier sessions (≤ 500 ms; missing = learn from scratch).
    try {
      const stored = await Promise.race([Promise.resolve(this.d.loadVoiceCal()).catch(() => ({})), sleep(500).then(() => ({}))]);
      if (!alive()) return;
      this.vcal = new VoiceCalibration(stored as Record<string, VoiceCalEntry>);
    } catch { this.vcal = new VoiceCalibration(); }
    this.observedT = video.currentTime || 0;

    const pitchOk = await pitchReady;
    if (!alive()) return;
    if (pitchOk && this.pitch?.hasGraph()) this.watcher.useGain((v) => this.pitch?.setGain(v));

    // Prefetch the first 30 s, waiting only for the first line so the first line is fast.
    const t = video.currentTime || 0;
    this.pump(t);
    const first = this.lines.find((l) => l.end >= t);
    if (first && this.prepared.has(first.id)) {
      await Promise.race([this.prepared.get(first.id)!.catch(() => null), sleep(4000)]);
      if (!alive()) return;
    }

    const continuous = this.settings.continuous;
    this.scheduler = new Scheduler(this.lines, this.makeClock(video), this.makeSpeaker(), {
      lang,
      leadMs: this.engineId === 'webspeech' ? 80 : 30,
      maxLagMs: continuous ? CONTINUOUS_MAX_LAG_MS : 0,
      video,
      // Continuous: whole-track pace plan (clusters, per-voice calibration). Strict: v1.0 per-line fit.
      plan: continuous ? undefined : (line, next) => this.planFor(line, next),
      planTrack: (ls) => this.planTrackFor(ls),
      onLineStart: (plan) => this.onLineStart(plan),
      onLineEnd: (plan, overflowMs) => this.onLineEnd(plan, overflowMs),
      onDuck: (on) => { if (!this.settings.holdDuck) this.watcher?.duck(on, this.settings.duckLevel); },
      onTick: (now) => this.pump(now),
    });
    this.scheduler.start();
    if (video.paused) this.scheduler.pause();
    this.pumpTimer = setInterval(() => this.pump(), 1000);
    if (this.watcher.isAdShowing()) this.onAdStart();
    else { this.holdDuck(); this.setStatus({ state: 'dubbing', videoId: this.videoId }); }
  }

  /** Stop speech, restore volume, remove listeners. Idempotent. */
  stop(): void {
    this.teardown();
    if (this.status.state !== 'idle') this.setStatus({ state: 'idle', videoId: this.videoId });
  }

  /** Release everything without emitting a status. */
  private teardown(): void {
    this.token++;
    const wasActive = this.active;
    if (this.officialAudio) {
      this.officialAudio = false;
      try { this.d.restoreOfficialAudio(this.videoId); } catch { /* ignore */ }
    }
    this.active = false;
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    this.pumpTimer = null;
    try { this.scheduler?.stop(); } catch { /* ignore */ }
    this.scheduler = null;
    try { this.engine?.stopAll(); } catch { /* ignore */ }
    try { this.engine?.dispose?.(); } catch { /* ignore */ }
    this.engine = null;
    try { this.watcher?.stop(); } catch { /* ignore */ }
    this.watcher = null;
    try { this.pitch?.stop(); } catch { /* ignore */ }
    this.pitch = null;
    if (this.calSaveTimer) clearTimeout(this.calSaveTimer);
    this.calSaveTimer = null;
    if (this.vcal.isDirty()) {
      try { void Promise.resolve(this.d.saveVoiceCal(this.vcal)).catch(() => {}); } catch { /* ignore */ }
    }
    this.prepared.clear();
    this.ready.clear();
    this.inflight = 0;
    this.setCurrent(null);
    void wasActive;
  }

  /** Turn on/off (omit = toggle). */
  async toggle(on?: boolean): Promise<DubStatus> {
    const want = on ?? !this.active;
    if (want) {
      if (!this.active) {
        try { await this.start(); } catch (e) { this.failFrom(e, 'ENGINE_ERROR'); }
      }
    } else {
      this.stop();
    }
    return this.getStatus();
  }

  isActive(): boolean { return this.active; }

  getStatus(): DubStatus {
    return { ...this.status };
  }

  /** Subscribe to status changes. Returns unsubscribe. */
  onStatus(cb: (s: DubStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Line being spoken now, or null. */
  currentLine(): Line | null {
    return this.current;
  }

  /** Feedback record for a line (thumbs), with the rate used and overflow past the line end. */
  feedbackFor(line: Line, up: boolean): Feedback {
    const info = this.lineInfo.get(line.id);
    return { videoId: this.videoId, lineId: line.id, lang: this.settings.targetLang, up, rate: info?.rate ?? 1, overflowMs: Math.round(info?.overflowMs ?? 0), at: Date.now() };
  }

  /** Apply changed settings live (volume, speed, voice, language → restart). */
  updateSettings(s: Settings): void {
    const prev = this.settings;
    this.settings = { ...s, voiceByLang: { ...s.voiceByLang } };
    this.cal = { ...this.cal, voiceSpeed: s.voiceSpeed };
    if (!this.active) return;
    if (prev.voiceSpeed !== s.voiceSpeed) this.scheduler?.replan();
    const lang = s.targetLang;
    const restart = prev.targetLang !== s.targetLang || prev.engine !== s.engine
      || prev.voiceByLang[lang] !== s.voiceByLang[lang] || prev.matchSpeakerGender !== s.matchSpeakerGender || prev.continuous !== s.continuous
      || prev.preferOfficialAudio !== s.preferOfficialAudio;
    if (restart) {
      this.stop();
      void this.start();
      return;
    }
    if (prev.duckLevel !== s.duckLevel) this.watcher?.setDuckLevel(s.duckLevel);
    if (prev.holdDuck !== s.holdDuck && this.status.state === 'dubbing') {
      if (s.holdDuck) this.holdDuck(); else this.watcher?.duck(false);
    }
    if (prev.dubVolume !== s.dubVolume) {
      try { this.handles.forEach((h) => h.setVolume?.(s.dubVolume)); } catch { /* ignore */ }
    }
  }

  // ---------------- internals ----------------

  private readonly handles = new Set<PlayHandle>();

  private setStatus(s: DubStatus): void {
    this.status = { ...s, videoId: this.videoId };
    if (this.status.firstLineMs == null && this.firstLineMs != null && (s.state === 'dubbing' || s.state === 'paused-ad')) {
      this.status.firstLineMs = this.firstLineMs;
    }
    if (this.current && s.state === 'dubbing') this.status.currentLineId = this.current.id;
    for (const cb of [...this.listeners]) {
      try { cb(this.getStatus()); } catch { /* ignore */ }
    }
  }

  private firstLineMs: number | undefined;

  private fail(code: DubErrorCode, message?: string): void {
    this.teardown();
    this.setStatus({ state: 'error', videoId: this.videoId, error: code, message });
  }

  private failFrom(e: unknown, fallback: DubErrorCode): void {
    if (e instanceof DubError) {
      const code = (['NO_CAPTIONS', 'NO_TRANSLATION', 'RATE_LIMITED', 'ENGINE_ERROR', 'NO_VOICE', 'NOT_WATCH_PAGE'] as const).includes(e.code as DubErrorCode)
        ? (e.code as DubErrorCode) : fallback;
      return this.fail(code, e.message);
    }
    return this.fail(fallback, e instanceof Error ? e.message : String(e));
  }

  private toast(message: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
    try { this.opts.onToast?.(message, kind); } catch { /* ignore */ }
  }

  /** Install a (possibly longer) line list; live scheduler keeps its place by time. */
  private applyLines(lines: Line[]): void {
    if (!lines.length) return;
    this.lines = [...lines].sort((a, b) => a.start - b.start);
    this.lineIndex = new Map(this.lines.map((l, i) => [l.id, i]));
    this.observedT = Math.min(this.observedT, this.video?.currentTime ?? this.observedT);
    this.scheduler?.setLines(this.lines);
    if (this.scheduler) this.pump();
  }

  private setEngine(id: EngineId): void {
    try { this.engine?.dispose?.(); } catch { /* ignore */ }
    // voiceSpeed is applied through the fit rate, so no provider `speed` (it would apply twice).
    this.engine = id === 'webspeech' ? this.d.createEngine(id) : this.d.createEngine(id, { onFallback: (e) => this.onEngineError(e) });
    this.engineId = id;
    // Web Speech reports measured speech time per line (onstart→onend) for per-voice calibration.
    const eng = this.engine as TtsEngine & { onMeasure?: (m: SpeechMeasure) => void };
    if (eng && id === 'webspeech') eng.onMeasure = (m) => this.onMeasure(m);
  }

  /** Resolve voices: user choice, best voice, and per-gender voices when gender matching is on. */
  private async resolveVoices(): Promise<boolean> {
    const lang = this.settings.targetLang;
    const eng = this.engineId;
    this.voiceByGender.clear();
    try { this.d.resetVoiceChoices(); } catch { /* ignore */ }
    let voices: VoiceInfo[] = [];
    try { voices = await this.d.listVoices(lang, eng); } catch { voices = []; }
    const chosenId = this.settings.voiceByLang[lang];
    const chosen = chosenId ? voices.find((v) => v.id === chosenId) ?? null : null;
    let best: VoiceInfo | null = chosen;
    if (!best) {
      try { best = await this.d.pickBestVoice(lang, eng, chosenId); } catch { best = null; }
    }
    // API engines may run without a listed voice (provider default); Web Speech needs one.
    const fallbackId = chosenId ?? best?.id;
    if (!fallbackId && eng === 'webspeech') return false;
    this.voiceByGender.set('unknown', fallbackId);
    if (this.settings.matchSpeakerGender) {
      for (const g of ['male', 'female'] as const) {
        if (chosen?.gender === g) { this.voiceByGender.set(g, chosen.id); continue; }
        let v: VoiceInfo | null = null;
        try { v = await this.d.pickVoiceFor(lang, g, eng, chosenId); } catch { v = null; }
        this.voiceByGender.set(g, v?.id ?? fallbackId);
      }
    }
    return true;
  }

  /** Gender used to voice a line: caption label first, else the previous speaker's pitch. */
  private genderFor(line: Line): Gender {
    if (!this.settings.matchSpeakerGender) return 'unknown';
    if (line.gender && line.gender !== 'unknown') return line.gender;
    const hint = captionGender(line); // "[Woman]", "(homme)"…
    if (hint !== 'unknown') return hint;
    return this.pitch?.predicted() ?? 'unknown';
  }

  private voiceFor(line: Line): string | undefined {
    const g = this.genderFor(line);
    return this.voiceByGender.get(g) ?? this.voiceByGender.get('unknown');
  }

  /** Calibration key of a voice: engine + language + voice id. */
  private voiceKey(voice: string | undefined): string {
    return `${this.engineId}:${this.settings.targetLang}:${voice ?? 'default'}`;
  }

  /**
   * Read speaker evidence from every line whose original audio has fully played (stable tracker with hysteresis).
   * A voice switch changes the speed factor of upcoming lines → replan.
   */
  private updateSpeaker(): void {
    const p = this.pitch;
    if (!p || !this.settings.matchSpeakerGender) return;
    const t = this.video?.currentTime ?? 0;
    if (!(t > this.observedT)) return;
    const before = p.predicted();
    const from = this.observedT;
    for (const line of this.lines) {
      if (line.end <= from) continue;
      if (line.end > t) break;
      try { p.observe(line); } catch { /* ignore */ }
    }
    this.observedT = t;
    if (p.predicted() !== before) this.scheduler?.replan();
  }

  /** Continuous-mode plan of the whole track: per-line voice speed factor (calibrated, or exact from known audio length). */
  private planTrackFor(lines: readonly Line[]): PacedPlan[] {
    const lang = this.settings.targetLang;
    // Pace reference = mean speed of the voices in use, so male and female voices sound equally fast.
    const keys = new Set([...this.voiceByGender.values()].map((v) => this.voiceKey(v)));
    const ref = [...keys].reduce((acc, k) => acc + this.vcal.factor(k), 0) / Math.max(1, keys.size);
    return planTrack(lines, (l) => {
      const u = estimateMs(l.text, lang);
      const voice = this.voiceKey(this.voiceFor(l));
      const known = this.ready.get(l.id)?.knownMs;
      const f = known != null && known > 0 && u > 0 ? Math.min(2, Math.max(0.5, u / known)) : this.vcal.factor(voice);
      return { u, f, voice };
    }, { voiceSpeed: this.settings.voiceSpeed, refFactor: ref });
  }

  /** Web Speech measured a line: learn that voice's real speed. */
  private onMeasure(m: SpeechMeasure): void {
    if (!this.active) return;
    const natural = m.speechMs * m.rate; // `rate` already includes the video playbackRate
    if (this.vcal.update(this.voiceKey(m.voice), estimateMs(m.text, m.lang), natural)) this.scheduler?.replan();
    this.scheduleCalSave();
  }

  private scheduleCalSave(): void {
    if (this.calSaveTimer) return;
    this.calSaveTimer = setTimeout(() => {
      this.calSaveTimer = null;
      try { void Promise.resolve(this.d.saveVoiceCal(this.vcal)).catch(() => {}); } catch { /* ignore */ }
    }, 5000);
  }

  private makeClock(video: HTMLVideoElement): Clock {
    return {
      now: () => video.currentTime,
      playbackRate: () => video.playbackRate || 1,
      paused: () => video.paused || this.watcher?.isAdShowing() === true,
    };
  }

  private planFor(line: Line, next: Line | undefined): Plan {
    const known = this.ready.get(line.id)?.knownMs;
    return fit(line, next, this.settings.targetLang, known, { ...this.cal, cpsFactor: this.vcal.factor(this.voiceKey(this.voiceFor(line))) });
  }

  /** Prepare lines starting within the next 30 s (max 3 in flight). Web Speech prepares at speak time (voice depends on the live speaker guess). */
  private pump(at?: number): void {
    if (!this.active || !this.engine || this.engineId === 'webspeech') return;
    const t = at ?? this.video?.currentTime ?? 0;
    for (const line of this.lines) {
      if (this.inflight >= PREFETCH_CONCURRENCY) break;
      if (line.end < t) continue;
      if (line.start > t + PREFETCH_S) break;
      if (this.prepared.has(line.id)) continue;
      this.prepareLine(line);
    }
  }

  private prepareLine(line: Line): Promise<Prepared> {
    const existing = this.prepared.get(line.id);
    if (existing) return existing;
    const engine = this.engine!;
    const token = this.token;
    this.inflight++;
    const p = engine.prepare(line, this.settings.targetLang, this.voiceFor(line)).then(
      (prep) => {
        if (token === this.token) {
          this.ready.set(line.id, prep);
          // Known audio length: exact pace for this line, and calibration for this voice's later lines.
          if (prep.knownMs != null && prep.knownMs > 0) {
            this.vcal.update(this.voiceKey(prep.voice), estimateMs(line.text, this.settings.targetLang), prep.knownMs);
            this.scheduleCalSave();
            this.scheduler?.replan();
          }
        }
        return prep;
      },
      (e) => {
        if (token === this.token) {
          this.prepared.delete(line.id);
          this.onEngineError(e);
        }
        throw e;
      },
    ).finally(() => {
      if (token === this.token) this.inflight = Math.max(0, this.inflight - 1);
    });
    p.catch(() => {});
    if (this.engineId !== 'webspeech') this.prepared.set(line.id, p);
    return p;
  }

  private makeSpeaker(): Speaker {
    return {
      speak: (plan) => this.speak(plan),
      stopAll: () => {
        try { this.engine?.stopAll(); } catch { /* ignore */ }
        for (const h of this.handles) try { h.stop(); } catch { /* ignore */ }
        this.handles.clear();
      },
      // Gapless chaining: engines that queue (Web Speech) get the next line before the current one ends.
      canQueue: () => {
        const e = this.engine as (TtsEngine & { canQueue?: () => boolean }) | null;
        return !!e && typeof e.canQueue === 'function' && e.canQueue();
      },
    };
  }

  /** Speak a plan now; if the audio is not ready yet, play it when it is (unless it became too late). */
  private speak(plan: Plan): PlayHandle {
    const line = plan.line;
    const lang = this.settings.targetLang;
    const engine = this.engine!;
    const volume = this.settings.dubVolume;
    if (engine.id === 'webspeech') this.updateSpeaker(); // voice chosen now: use the freshest speaker evidence
    const ready = this.ready.get(line.id);
    const continuous = this.settings.continuous;
    const lazy = new LazyHandle();
    this.handles.add(lazy);
    lazy.done.then(() => this.handles.delete(lazy));
    const play = (prep: Prepared) => {
      if (lazy.isStopped()) return lazy.end('stopped');
      // Strict mode drops a line that became > 0.3 s late. Continuous mode starts lines late on purpose (chained after
      // the previous one): v1.0 dropped those too, which made the silence holes. Only a lag beyond the skip limit drops.
      const lateS = (this.video?.currentTime ?? plan.startAt) - plan.startAt;
      if (lateS > (continuous ? CONTINUOUS_MAX_LAG_MS / 1000 : 0.3)) return lazy.end('stopped');
      let inner: PlayHandle;
      try {
        inner = engine.play(prep, plan.rate, volume);
      } catch (e) {
        this.onEngineError(e);
        return lazy.end('error');
      }
      lazy.attach(inner);
      inner.done.then((r) => {
        if (r === 'error') this.onEngineError(new Error('playback failed'));
      });
    };
    if (ready) {
      play(ready);
    } else {
      const p = this.engineId === 'webspeech'
        ? engine.prepare(line, lang, this.voiceFor(line))
        : this.prepareLine(line);
      p.then(play, () => lazy.end('error'));
    }
    return lazy;
  }

  private onEngineError(e: unknown): void {
    if (!this.active || this.engineId === 'webspeech' || this.fallingBack) return;
    this.fallingBack = true;
    console.warn('[autodub] voice engine failed, falling back to Web Speech', e instanceof Error ? e.message : e);
    this.toast('Voice service failed — switched to the free browser voice', 'warn');
    try { this.engine?.stopAll(); } catch { /* ignore */ }
    try {
      this.setEngine('webspeech');
    } catch (e2) {
      return this.failFrom(e2, 'ENGINE_ERROR');
    }
    this.prepared.clear();
    this.ready.clear();
    this.inflight = 0;
    void this.resolveVoices().then((ok) => {
      this.fallingBack = false;
      if (!ok && this.active) this.fail('NO_VOICE', `No ${this.settings.targetLang} browser voice installed.`);
    });
  }

  private onLineStart(plan: Plan): void {
    const line = plan.line;
    // Update the (stable) speaker guess from the original audio of lines that have played.
    this.updateSpeaker();
    this.lineInfo.set(line.id, { rate: plan.rate, overflowMs: 0 });
    if (this.lineInfo.size > 2000) this.lineInfo.delete(this.lineInfo.keys().next().value as string);
    this.setCurrent(line);
    if (!this.firstLineDone) {
      this.firstLineDone = true;
      const ms = Math.round(this.d.now() - this.t0);
      this.firstLineMs = ms;
      this.status = { ...this.status, firstLineMs: ms };
      try {
        void Promise.resolve(this.d.saveStat({ videoId: this.videoId, lang: this.settings.targetLang, engine: this.engineId, ms, at: Date.now() })).catch(() => {});
      } catch { /* ignore */ }
    }
    if (this.status.state === 'dubbing') this.setStatus({ ...this.status, currentLineId: line.id });
  }

  private onLineEnd(plan: Plan, overflowMs: number): void {
    const info = this.lineInfo.get(plan.line.id);
    if (info) info.overflowMs = overflowMs;
    if (this.current?.id === plan.line.id) this.setCurrent(null);
  }

  private setCurrent(line: Line | null): void {
    this.current = line;
    try { this.opts.onLine?.(line); } catch { /* ignore */ }
  }

  private onAdStart(): void {
    if (!this.active) return;
    this.scheduler?.seek(this.video?.currentTime ?? 0); // stops speech, clears duck
    this.scheduler?.pause();
    this.watcher?.restoreVolume();
    this.setCurrent(null);
    this.setStatus({ ...this.status, state: 'paused-ad', currentLineId: undefined });
    this.toast('Ad playing — dub paused', 'info');
  }

  private onAdEnd(): void {
    if (!this.active || !this.scheduler) return;
    const v = this.video;
    this.scheduler.seek(v?.currentTime ?? 0);
    if (!v?.paused) this.scheduler.resume();
    this.holdDuck();
    this.setStatus({ ...this.status, state: 'dubbing' });
  }

  /** holdDuck: keep the original audio at duckLevel for the whole dub (kids hear only the dub). */
  private holdDuck(): void {
    if (this.settings.holdDuck) this.watcher?.duck(true, this.settings.duckLevel);
  }
}

/** PlayHandle that may be attached to the real engine handle later (audio still preparing). */
class LazyHandle implements PlayHandle {
  readonly done: Promise<PlayEnd>;
  private resolve!: (r: PlayEnd) => void;
  private inner: PlayHandle | null = null;
  private stopped = false;
  private paused = false;
  private rate: number | null = null;
  private volume: number | null = null;
  private finished = false;

  constructor() {
    this.done = new Promise((r) => { this.resolve = r; });
  }

  attach(h: PlayHandle): void {
    this.inner = h;
    if (this.paused) try { h.pause(); } catch { /* ignore */ }
    if (this.rate != null) try { h.setRate?.(this.rate); } catch { /* ignore */ }
    if (this.volume != null) try { h.setVolume?.(this.volume); } catch { /* ignore */ }
    Promise.resolve(h.done).then((r) => this.end(r), () => this.end('error'));
  }

  end(r: PlayEnd): void {
    if (this.finished) return;
    this.finished = true;
    this.resolve(r);
  }

  isStopped(): boolean { return this.stopped; }

  stop(): void {
    this.stopped = true;
    if (this.inner) try { this.inner.stop(); } catch { /* ignore */ }
    this.end('stopped');
  }

  pause(): void {
    this.paused = true;
    this.inner?.pause();
  }

  resume(): void {
    this.paused = false;
    this.inner?.resume();
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.inner?.setRate?.(rate);
  }

  setVolume(volume: number): void {
    this.volume = volume;
    this.inner?.setVolume?.(volume);
  }
}

/**
 * Best-effort Translator warm-up inside the Dub click: the video's source language is not known yet,
 * so it pre-creates English → target (the common case for kids' videos). Rejections are ignored;
 * the pipeline's own translateLocal() then finds the model already downloaded or downloading.
 */
export function warmUpTranslator(to: Lang, onProgress?: (pct: number) => void): void {
  if (to === 'en') return;
  const T = getTranslatorGlobal();
  if (!T) {
    // v1.1 (F): no Translator in the isolated world → warm it up in the page world (same window activation).
    try { void bridgeRequest('translatorWarmup', { from: 'en', to }, { timeoutMs: 3000 }).catch(() => {}); } catch { /* ignore */ }
    return;
  }
  const p = T.create({
    sourceLanguage: 'en',
    targetLanguage: to,
    monitor: (m) => m.addEventListener('downloadprogress', (e) => {
      const loaded = typeof e.loaded === 'number' ? e.loaded : 0;
      onProgress?.(Math.round(Math.min(1, Math.max(0, loaded)) * 100));
    }),
  });
  Promise.resolve(p).then((tr) => { try { tr.destroy?.(); } catch { /* ignore */ } }, () => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Append a time-to-first-line sample to storage.local `stats.firstLine` (ring of 50). */
export async function saveFirstLineStat(s: FirstLineStat): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  const got = await chrome.storage.local.get(STORAGE_KEYS.stats);
  const stats = (got[STORAGE_KEYS.stats] && typeof got[STORAGE_KEYS.stats] === 'object' ? got[STORAGE_KEYS.stats] : {}) as { firstLine?: FirstLineStat[] };
  const list = Array.isArray(stats.firstLine) ? stats.firstLine : [];
  list.push(s);
  await chrome.storage.local.set({ [STORAGE_KEYS.stats]: { ...stats, firstLine: list.slice(-STATS_MAX) } });
}
