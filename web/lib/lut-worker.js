// Profile LUT building in a Worker (plan §5, P1): buildLUT 33^3 takes tens to hundreds of
// milliseconds on the main thread and blocks the UI. The model is loaded here once, the control
// arrives as a message, the result leaves as a transferable Float32Array without a copy. The build
// is not physically interrupted, but stale generations (gen) are not sent: generations are
// assigned by app.js, and a newer request may have arrived while this one was building.
import { fetchModel, buildLUT } from "./profile.js";

let modelPromise = null;
let latest = 0;   // the latest generation from the main thread

self.onmessage = (e) => {
  const { id, gen, control, n } = e.data;
  latest = gen;
  (modelPromise ??= fetchModel(new URL("../model/", import.meta.url).href))
    .then((model) => {
      if (gen !== latest) return;                 // stale before the build even started
      const lut = buildLUT(model, control, n);    // synchronous: this is the whole point of moving it off the main
      if (gen !== latest) return;                 // the build cannot be interrupted, the result is not needed
      self.postMessage({ id, lut }, [lut.buffer]);
    })
    .catch((err) => {
      if (gen === latest) self.postMessage({ id, error: String((err && err.message) || err) });
    });
};
