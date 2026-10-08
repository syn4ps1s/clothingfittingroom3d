/* global self, WebAssembly */
// Worker del MISMO origen: comprueba que puede instanciar WebAssembly bajo la CSP ('wasm-unsafe-eval').
self.onmessage = async (event) => {
  try {
    await WebAssembly.instantiate(event.data);
    self.postMessage({ ok: true });
  } catch (error) {
    self.postMessage({ ok: false, error: String(error) });
  }
};
