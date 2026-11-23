import type { LegacyAssembly, StoredAssembly, TspfAssembly } from '../contracts/types.ts'

const outfit: TspfAssembly = { outfit: 'T01-frog', cloth: null, accessory: null, face: 'F01-neutral' }
const single: TspfAssembly = { outfit: null, cloth: 'S02-leaf-cape', accessory: 'P19-blue-wings', face: 'F02-wink' }
const legacy: LegacyAssembly = { cloth: 'jacket', hat: 'beanie', glasses: 'round', face: 'happy' }
export const stored: readonly StoredAssembly[] = [outfit, single, legacy]

// @ts-expect-error Suite selections cannot carry an accessory.
export const mixed: TspfAssembly = { ...outfit, accessory: 'P19-blue-wings' }
// @ts-expect-error Removed expression IDs are invalid.
export const removed: TspfAssembly = { ...single, face: 'F09-dark' }
// @ts-expect-error Legacy assemblies are read-only in K v6.
export const legacyWrite: TspfAssembly = legacy
