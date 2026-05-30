import { describe, it, expect } from 'vitest'
import { canonicalPrintMode, ALL_PRESETS, OVERLAPPING_PRESETS, presetFolder } from './printMode'

describe('canonicalPrintMode — Breathing Color filenames', () => {
  const cases: Array<[string, string]> = [
    ['BC_800M_P9000_mk_CanvasMatte.icm', 'CanvasMatte'],
    ['BC_BelgianLinen_P9000_mk_CanvasMatte.icm', 'CanvasMatte'],
    ['BC_ChromataWhite_P9000_mk_CanvasMatte.icm', 'CanvasMatte'],
    ['BC_DecorMatte_P9000_mk_CanvasMatte.icm', 'CanvasMatte'],
    ['BC_Lyve_P9000_mk_CanvasMatte.icm', 'CanvasMatte'],
    ['BC_17MGloss_P9000_pk_CanvasSatin.icm', 'CanvasSatin'],
    ['BC_17MSatin_P9000_pk_CanvasSatin.icm', 'CanvasSatin'],
    ['BC_Crystalline_P9000_pk_CanvasSatin.icm', 'CanvasSatin'],
    ['BC_Silverada_P9000_pk_CanvasSatin.icm', 'CanvasSatin'],
    ['BC_VibranceLuster_P9000_PLPP260.icm', 'PremiumLuster'],
    // numeric offset suffix must not break mode detection
    ['BC_RiverStoneSatinRag_P9000_pk_PLPP260_-15.icm', 'PremiumLuster'],
    ['BC_PhotoPeelGloss_P9000_pk_PGPP.icm', 'PremiumGlossy'],
    ['BC_VibranceGloss_P9000_pk_PGPP.icm', 'PremiumGlossy'],
    ['BC_VibranceMetallic_P9000_PGPP260.icm', 'PremiumGlossy'],
    ['BC_600MT_P9000_mk_WCRW.icm', 'WatercolorRadiantWhite'],
    ['BC_BagasseSmooth_P9000_mk_WCRW.icm', 'WatercolorRadiantWhite'],
    ['BC_BagasseText_P9000_mk_WCRW.icm', 'WatercolorRadiantWhite'],
    ['BC_EleganceVelvet_P9000_mk_WCRW.icm', 'WatercolorRadiantWhite'],
    ['BC_OpticaOne_P9000_mk_WCRW.icm', 'WatercolorRadiantWhite'],
    ['BC_PuraSmooth_P9000_mk_WCRW.icm', 'WatercolorRadiantWhite'],
    ['BC_PuraVelvet_P9000_mk_WCRW.icm', 'WatercolorRadiantWhite'],
    ['BC_Signa270_P9000_MK_WCRW.icc', 'WatercolorRadiantWhite'],
    ['BC_VibrancePhotoMatte_mk_P9000_WCRW.icm', 'WatercolorRadiantWhite'],
    ['BC_1930_P9000_pk_EMP.icm', 'EnhancedMatte'],
    ['BC_AllureAq_P9000_MK_EMP.icm', 'EnhancedMatte'],
    ['BC_AllureAq_P9000_MK_EMP.cxf', 'EnhancedMatte'],
    ['BC_ArtPeelBlckt_P9000_mk_EMP.icm', 'EnhancedMatte'],
    ['BC_PhotoPeelMatte_P9000_mk_SWM.icm', 'SingleweightMatte'],
  ]
  it.each(cases)('%s → %s', (filename, expected) => {
    expect(canonicalPrintMode(filename)).toBe(expected)
  })
})

describe('canonicalPrintMode — MOAB filenames', () => {
  const cases: Array<[string, string]> = [
    ['MOAB Anasazi Canvas P9000 Exh Canvas Matte.icc', 'CanvasMatte'],
    // substrate name contains "Gloss" but the print mode is Prem Luster
    ['MOAB Colorado Fiber Gloss P9000 Prem Luster.icc', 'PremiumLuster'],
    ['MOAB Colorado Fiber Satine P9000 Prem Luster.icc', 'PremiumLuster'],
    ['MOAB Juniper Baryta P9000 Prem Luster.icc', 'PremiumLuster'],
    ['MOAB Lasal Exhibition Luster P9000 Prem Luster.icc', 'PremiumLuster'],
    ['MOAB Lasal Gloss P9000 Prem Glossy.icc', 'PremiumGlossy'],
    ['MOAB Slickrock Silver P9000 Prem Glossy.icc', 'PremiumGlossy'],
    ['MOAB Lasal Dual Semigloss P9000 Prem Semigloss.icc', 'PremiumSemigloss'],
    ['MOAB Slickrock Pearl P9000 Prem Semigloss.icc', 'PremiumSemigloss'],
    ['MOAB Entrada Rag Bright P9000 USFA.icc', 'UltrasmoothFineArt'],
    ['MOAB Entrada Rag Natural P9000 USFA.icc', 'UltrasmoothFineArt'],
    ['MOAB Entrada Rag Textured P9000 USFA.icc', 'UltrasmoothFineArt'],
    ['MOAB Lasal Matte P9000 USFA.icc', 'UltrasmoothFineArt'],
    ['MOAB Moenkopi Kozo P9000 USFA.icc', 'UltrasmoothFineArt'],
    ['MOAB Moenkopi Unryu P9000 USFA.icc', 'UltrasmoothFineArt'],
    ['MOAB Somerset Museum Rag P9000 USFA.icc', 'UltrasmoothFineArt'],
    ['MOAB Moenkopi Bizan P9000 VFA.icc', 'VelvetFineArt'],
    ['MOAB Somerset Velvet P9000 VFA.icc', 'VelvetFineArt'],
  ]
  it.each(cases)('%s → %s', (filename, expected) => {
    expect(canonicalPrintMode(filename)).toBe(expected)
  })
})

describe('canonicalPrintMode — errors', () => {
  it('throws on an unrecognised mode', () => {
    expect(() => canonicalPrintMode('BC_Foo_P9000_mk_UNKNOWNMEDIA.icm')).toThrow(
      /unrecognised print mode/,
    )
  })
})

describe('preset tables', () => {
  it('has 10 presets and folder name equals preset id', () => {
    expect(ALL_PRESETS).toHaveLength(10)
    for (const p of ALL_PRESETS) expect(presetFolder(p)).toBe(p)
  })
  it('overlapping presets are the three cross-vendor ones', () => {
    expect(new Set(OVERLAPPING_PRESETS)).toEqual(
      new Set(['CanvasMatte', 'PremiumLuster', 'PremiumGlossy']),
    )
  })
})
