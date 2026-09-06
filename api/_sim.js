// Thin wrapper over the shared physics. The real arithmetic lives in
// /physics.js at the site root, which the browser also loads, so lockstep is
// structural instead of a discipline problem. Signatures are unchanged: power
// arrives as the same 0..100 decimal the wire has always carried and is
// converted exactly once, exactly, inside the module.
import '../physics.js';

const P = globalThis.PIPPHYS;

export const simulate = (seed, angle, power) => P.simulate(seed, angle, power);
export const simulateRace = (seed, inputs) => P.simulateRace(seed, inputs);
