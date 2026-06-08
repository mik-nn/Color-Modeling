// frontend/src/lib/analyzers/dynamicLOO.test.ts
import { describe, it, expect } from 'vitest'
import { predictTargetWithLOO, type LOOConfig, type LOOProfileData } from './dynamicLOO'
import type { CAEWeights } from '../predict/cae'

describe('predictTargetWithLOO', () => {
  const N = 10
  const L = 36

  const makeProfile = (name: string): LOOProfileData => {
    const spectra = new Float64Array(N * L).fill(0.5)
    const deviceValues = new Float64Array(N * 3).fill(128)
    return {
      spectra,
      deviceValues,
      paperSpectrum: Array(L).fill(0.8),
      sampleIds: Array.from({ length: N }, (_, i) => `patch_${i}`),
      profileName: name,
    }
  }

  const mockWeights: CAEWeights = {
    schema_version: 1,
    variant: 'd7',
    arch: {
      spectral_dim: L,
      rgb_dim: 3,
      substrate_latent_dim: 8,
      ink_latent_dim: 16,
      hidden_dim: 64,
      n_substrate_ids: 10,
    },
    id_table: {},
    null_id: 0,
    split: { train: [], test: [] },
    best_test_mse: 0.00054,
    layers: {
      'substrate_fc1.weight': Array(32).fill(Array(46).fill(0.01)),
      'substrate_fc1.bias': Array(32).fill(0),
      'substrate_fc2.weight': Array(8).fill(Array(32).fill(0.01)),
      'substrate_fc2.bias': Array(8).fill(0),
      'encoder_fc1.weight': Array(64).fill(Array(47).fill(0.01)),
      'encoder_fc1.bias': Array(64).fill(0),
      'encoder_fc2.weight': Array(16).fill(Array(64).fill(0.01)),
      'encoder_fc2.bias': Array(16).fill(0),
      'decoder_fc1.weight': Array(64).fill(Array(27).fill(0.01)),
      'decoder_fc1.bias': Array(64).fill(0),
      'decoder_fc2.weight': Array(L).fill(Array(64).fill(0.01)),
      'decoder_fc2.bias': Array(L).fill(0),
    },
  }

  it('optimizes latent on support set and predicts target', () => {
    const supportProfiles = [makeProfile('profile1'), makeProfile('profile2')]
    const target = makeProfile('target')

    const config: LOOConfig = {
      nmIterations: 5,
      nmTolerance: 1e-4,
      anchorIndices: [],
      L,
    }

    const result = predictTargetWithLOO(mockWeights, supportProfiles, target, config)

    expect(result.optimizedLatent).toHaveLength(8)
    expect(result.X_pred).toHaveLength(N * L)
    expect(typeof result.report.medianDE00).toBe('number')
    expect(result.anchorFineTuned).toBe(false)
    expect(result.looSupportCount).toBe(2)
  })

  it('includes anchor patches in few-shot loss when anchorIndices given', () => {
    const supportProfiles = [makeProfile('profile1')]
    const target = makeProfile('target')

    const config: LOOConfig = {
      nmIterations: 5,
      nmTolerance: 1e-4,
      anchorIndices: [0, 5],
      L,
    }

    const result = predictTargetWithLOO(mockWeights, supportProfiles, target, config)

    expect(result.anchorFineTuned).toBe(true)
    expect(result.optimizedLatent).toHaveLength(8)
  })
})
