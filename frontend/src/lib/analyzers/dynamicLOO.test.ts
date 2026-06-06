// frontend/src/lib/analyzers/dynamicLOO.test.ts
import { describe, it, expect } from 'vitest'
import { predictTargetWithLOO, type LOOConfig } from './dynamicLOO'
import type { Measurement } from '../../types'
import type { CAEWeights } from '../predict/cae'

describe('predictTargetWithLOO', () => {
  const createMockMeasurement = (id: string, lab: [number, number, number]): Measurement => ({
    SAMPLE_ID: id,
    spectra: Array(36).fill(0.5),
    LAB_L: lab[0],
    LAB_A: lab[1],
    LAB_B: lab[2],
    CMYK_C: 0,
    CMYK_M: 0,
    CMYK_Y: 0,
    CMYK_K: 0,
  })

  const createMockProfile = (name: string, nPatches: number = 10) => ({
    profile: {
      raw: Array.from({ length: nPatches }, (_, i) => 
        createMockMeasurement(`${name}_patch_${i}`, [50 + i, 10, -5])
      ),
      wavelengths: Array.from({ length: 36 }, (_, i) => 380 + i * 10),
    },
    paperSpectrum: Array(36).fill(0.8),
    sampleIds: Array.from({ length: nPatches }, (_, i) => `patch_${i}`),
    deviceValues: new Float64Array(nPatches * 3).fill(128),
  })

  const mockWeights: CAEWeights = {
    schema_version: 1,
    variant: 'd7',
    arch: {
      spectral_dim: 36,
      rgb_dim: 3,
      substrate_latent_dim: 8,
      ink_latent_dim: 16,
      hidden_dim: 64,
      n_substrate_ids: 10,
    },
    id_table: {},
    null_id: -1,
    split: { train: [], test: [] },
    best_test_mse: 0.00054,
    layers: {
      'substrate_fc1.weight': Array(32).fill(Array(44).fill(0.1)),
      'substrate_fc1.bias': Array(32).fill(0),
      'substrate_fc2.weight': Array(8).fill(Array(32).fill(0.1)),
      'substrate_fc2.bias': Array(8).fill(0),
      'encoder_fc1.weight': Array(64).fill(Array(47).fill(0.1)),
      'encoder_fc1.bias': Array(64).fill(0),
      'encoder_fc2.weight': Array(16).fill(Array(64).fill(0.1)),
      'encoder_fc2.bias': Array(16).fill(0),
      'decoder_fc1.weight': Array(64).fill(Array(27).fill(0.1)),
      'decoder_fc1.bias': Array(64).fill(0),
      'decoder_fc2.weight': Array(36).fill(Array(64).fill(0.1)),
      'decoder_fc2.bias': Array(36).fill(0),
    },
  }

  it('optimizes latent on support set and predicts target', () => {
    const supportProfiles = [
      createMockProfile('profile1', 10),
      createMockProfile('profile2', 10),
    ]
    const targetProfile = createMockProfile('target', 10)

    const config: LOOConfig = {
      nmIterations: 10,
      nmTolerance: 1e-4,
      useAnchorResiduals: false,
      anchorIndices: [],
      L: 36,
    }

    const result = predictTargetWithLOO(mockWeights, supportProfiles, targetProfile, config)

    expect(result.optimizedLatent).toHaveLength(8)
    expect(result.X_pred).toHaveLength(360)
    expect(typeof result.medianDE00).toBe('number')
    expect(typeof result.p95DE00).toBe('number')
    expect(result.anchorFineTuned).toBe(false)
  })

  it('applies anchor residuals when configured', () => {
    const supportProfiles = [createMockProfile('profile1', 10)]
    const targetProfile = createMockProfile('target', 10)

    const config: LOOConfig = {
      nmIterations: 5,
      nmTolerance: 1e-4,
      useAnchorResiduals: true,
      anchorIndices: [0, 5, 9],
      L: 36,
    }

    const result = predictTargetWithLOO(mockWeights, supportProfiles, targetProfile, config)

    expect(result.anchorFineTuned).toBe(true)
  })
})