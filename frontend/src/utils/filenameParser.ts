// src/utils/filenameParser.ts

import { ProfileMetadata } from '../types'

export function parseProfileFilename(filename: string): ProfileMetadata {
  const name = filename.replace(/\.(icm|icc|cxf)$/i, '').trim()
  const parts = name.split('_')

  const metadata: ProfileMetadata = {
    full_name: name,
    brand: parts[0] || '',
    series: '',
    printer: '',
    ink: '',
    substrate: '',
    parsed_at: new Date().toISOString(),
  }

  const moabTokens = name.split(/\s+/)
  const printerIdx = moabTokens.findIndex((t) => /^P\d{4}$/i.test(t))
  if (moabTokens[0]?.toLowerCase() === 'moab' && printerIdx > 1) {
    const substrate = moabTokens.slice(1, printerIdx).join(' ')
    const printMode = moabTokens.slice(printerIdx + 1).join(' ')
    metadata.brand = 'MOAB'
    metadata.series = substrate
    metadata.printer = moabTokens[printerIdx]
    metadata.ink = ''
    metadata.substrate = substrate
    metadata.printMode = printMode
    return metadata
  }

  // Основные случаи именования
  if (parts.length >= 4) {
    metadata.printer = parts[2] || ''

    if (parts.length === 5) {
      // Формат: BC_Series_Printer_Ink_Substrate
      metadata.series = parts[1]
      metadata.ink = parts[3]
      metadata.substrate = parts[4]
      metadata.printMode = parts[4]
    } else if (parts.length === 4) {
      // Формат: BC_Series_Printer_SubstrateOrInk
      metadata.series = parts[1]
      const lastPart = parts[3]
      metadata.printMode = lastPart

      // Если последнее поле содержит буквы и выглядит как материал — это substrate
      if (/[a-zA-Z]/.test(lastPart) && !/^\d+$/.test(lastPart)) {
        metadata.substrate = lastPart
        metadata.ink = parts[2] // иногда ink попадает сюда
      } else {
        metadata.ink = lastPart
        metadata.substrate = parts[1] // fallback
      }
    } else {
      // Fallback для нестандартных имён
      metadata.series = parts.slice(1).join('_')
      metadata.printMode = parts[parts.length - 1]
    }
  } else {
    metadata.series = name
    metadata.printMode = parts[parts.length - 1] || name
  }

  return metadata
}
