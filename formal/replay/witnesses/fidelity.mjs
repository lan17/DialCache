import { isDeepStrictEqual } from "node:util";

// The fidelity scaffold the public-only classifiers share. A classifier
// shadows from the recorded inputs and the asserted public channels what its
// rules need and, wherever a history still carries the model's private
// predictions, compares the shadow after every step with them field by field,
// so a shadow that drifts from the model is refused rather than credited.
// What differs per classifier is handed to `fidelityBinding`: the public
// channels a projected history is reduced to, the layout fields a private
// state must carry before it is read (a history in another layout is named at
// its first missing field rather than misread), and `view(shadow, state,
// context)`, which returns the two records to compare in the classifier's own
// field names: the shadow's view first, the model's second.

// A history projected to its public channels carries nothing to compare; any
// other decoded field is the model's private layout.
export const carriesPrivateState = (predictions, publicChannels) => predictions !== undefined
  && predictions.some(state => Object.keys(state).some(field => !publicChannels.includes(field)));

export function requireLayout(state, layoutFields, context) {
  for (const field of layoutFields) if (!Object.hasOwn(state, field)) throw new Error(`${context}: private layout is missing ${field}`);
  return state;
}

// The shadow's view against the model's, naming the first field that differs.
export function compareViews(ours, theirs, context) {
  for (const [field, value] of Object.entries(ours)) {
    if (!isDeepStrictEqual(value, theirs[field])) throw new Error(`${context}: shadow ${field} ${JSON.stringify(value)} differs from the model's ${JSON.stringify(theirs[field])}`);
  }
}

// shadows[0] is the initial shadow and shadows[i] the shadow after step i;
// predictions[i] is the model's private state at step i.
export function checkFidelity(shadows, predictions, path, view) {
  for (const [index, shadow] of shadows.entries()) {
    const context = `${path} step ${index}`;
    const [ours, theirs] = view(shadow, predictions[index], context);
    compareViews(ours, theirs, context);
  }
}

// The shadows of a frame walk: the initial shadow, then each frame's `after`.
export const shadowSequence = (initial, frames) => [initial, ...frames.map(frame => frame.after)];

export function fidelityBinding({ publicChannels, layoutFields = [], view }) {
  return {
    carriesPrivateState: predictions => carriesPrivateState(predictions, publicChannels),
    checkFidelity: (shadows, predictions, path) => checkFidelity(shadows, predictions, path,
      (shadow, state, context) => view(shadow, requireLayout(state, layoutFields, context), context)),
  };
}
