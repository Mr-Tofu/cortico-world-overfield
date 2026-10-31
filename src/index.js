/**
 * World definition: Coopanion loads the default export and expects a
 * WorldDefinition with `cortico.kind = "world"` and `cortico.api = 6`.
 */

import { OverfieldWorld } from './world.js';
import { DEFAULTS, OVERFIELD_ID } from './config.js';

export const OVERFIELD = {
  id: OVERFIELD_ID,
  label: '开放空间',
  defaults: () => structuredClone(DEFAULTS),
  create: (ctx) => new OverfieldWorld(ctx),
};

export default OVERFIELD;
