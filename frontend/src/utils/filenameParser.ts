// src/utils/filenameParser.ts

import { ProfileMetadata } from '../types';

export function parseProfileFilename(filename: string): ProfileMetadata {
  const name = filename.replace(/\.icm$/i, '').trim();
  const parts = name.split('_');

  const metadata: ProfileMetadata = {
    full_name: name,
    brand: parts[0] || '',
    series: '',
    printer: '',
    ink: '',
    substrate: '',
    parsed_at: new Date().toISOString(),
  };

  // Основные случаи именования
  if (parts.length >= 4) {
    metadata.printer = parts[2] || '';

    if (parts.length === 5) {
      // Формат: BC_Series_Printer_Ink_Substrate
      metadata.series = parts[1];
      metadata.ink = parts[3];
      metadata.substrate = parts[4];
    } 
    else if (parts.length === 4) {
      // Формат: BC_Series_Printer_SubstrateOrInk
      metadata.series = parts[1];
      const lastPart = parts[3];

      // Если последнее поле содержит буквы и выглядит как материал — это substrate
      if (/[a-zA-Z]/.test(lastPart) && !/^\d+$/.test(lastPart)) {
        metadata.substrate = lastPart;
        metadata.ink = parts[2]; // иногда ink попадает сюда
      } else {
        metadata.ink = lastPart;
        metadata.substrate = parts[1]; // fallback
      }
    } 
    else {
      // Fallback для нестандартных имён
      metadata.series = parts.slice(1).join('_');
    }
  } else {
    metadata.series = name;
  }

  return metadata;
}

// Тестовые примеры
export function testParser() {
  const tests = [
    "BC_Lyve_P9000_mk_CanvasMatte.icm",
    "BC_VibranceLuster_P9000_PLPP260.icm",
    "BC_600MT_P9000_mk_WCRW.icm"
  ];

  tests.forEach(file => {
    console.log(file);
    console.dir(parseProfileFilename(file), { depth: null });
    console.log('---');
  });
}