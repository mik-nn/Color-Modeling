// src/utils/filenameParser.test.ts
import { expect, test } from 'vitest'
import { parseProfileFilename } from './filenameParser'

test('Парсер правильно обрабатывает разные форматы имён', () => {
  const testCases = [
    {
      input: 'BC_Lyve_P9000_mk_CanvasMatte.icm',
      expected: { series: 'Lyve', printer: 'P9000', ink: 'mk', substrate: 'CanvasMatte' },
    },
    {
      input: 'BC_VibranceLuster_P9000_PLPP260.icm',
      expected: { series: 'VibranceLuster', printer: 'P9000', substrate: 'PLPP260' },
    },
    {
      input: 'BC_600MT_P9000_mk_WCRW.icm',
      expected: { series: '600MT', printer: 'P9000', ink: 'mk', substrate: 'WCRW' },
    },
  ]

  testCases.forEach(({ input, expected }) => {
    const result = parseProfileFilename(input)
    expect(result.series).toBe(expected.series)
    expect(result.printer).toBe(expected.printer)
    expect(result.substrate).toBe(expected.substrate || result.substrate)
  })
})

test('Парсер извлекает MOAB paper и print mode из ICC имени', () => {
  const result = parseProfileFilename('MOAB Lasal Exhibition Luster P9000 Prem Luster.icc')

  expect(result.brand).toBe('MOAB')
  expect(result.series).toBe('Lasal Exhibition Luster')
  expect(result.substrate).toBe('Lasal Exhibition Luster')
  expect(result.printer).toBe('P9000')
  expect(result.printMode).toBe('Prem Luster')
})

test('Парсер сохраняет последний сегмент как printMode для BC имён', () => {
  const result = parseProfileFilename('BC_DecorMatte_P9000_mk_CanvasMatte.icm')

  expect(result.ink).toBe('mk')
  expect(result.substrate).toBe('CanvasMatte')
  expect(result.printMode).toBe('CanvasMatte')
})
