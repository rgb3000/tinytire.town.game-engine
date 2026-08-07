/**
 * Copy an object, dropping keys whose value is `undefined`.
 *
 * This is the bulk form of the `if (o.top !== undefined) def.top = o.top;` idiom used
 * in `src/maps/loadMap.ts`. It matters under `exactOptionalPropertyTypes`: a property
 * that is *present and undefined* is not the same as one that is *absent*, and the
 * difference is load-bearing wherever the result is spread over defaults.
 *
 * `buildConfig` (`src/constants.ts`) and `buildColorTheme` (`src/designer/colorTheme.ts`)
 * both do `{ ...DEFAULTS, ...overrides }`. A spread copies explicit `undefined` values,
 * so `{ ...{CAR_SPEED: 1}, ...{CAR_SPEED: undefined} }` yields `{CAR_SPEED: undefined}` —
 * the default is destroyed and the engine goes on to compute with `NaN`. Passing
 * overrides through here first makes that unrepresentable.
 *
 * Zod is the usual source of such values: `z.number().optional()` infers
 * `number | undefined` rather than an exact-optional property.
 */
export function omitUndefined<T extends object>(source: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) result[key] = value;
  }
  // The one cast: TypeScript cannot follow "same keys, minus the undefined ones"
  // through an index-signature accumulator. The loop above is the proof.
  return result as { [K in keyof T]?: Exclude<T[K], undefined> };
}
