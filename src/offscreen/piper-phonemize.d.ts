// emscripten build of piper-phonemize (CommonJS export of the module factory).
declare module '@diffusionstudio/piper-wasm/build/piper_phonemize.js' {
  const createPiperPhonemize: (moduleArg?: Record<string, unknown>) => Promise<{ callMain(args: string[]): number }>;
  export default createPiperPhonemize;
}
