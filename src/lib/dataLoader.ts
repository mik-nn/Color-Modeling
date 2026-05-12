// src/lib/dataLoader.ts
import { ProfileData, ProfileMetadata, Measurement } from '../types';
import { parseProfileFilename } from '../utils/filenameParser';

export async function loadProfile(file: File): Promise<ProfileData> {
  const metadata = parseProfileFilename(file.name);

  // TODO: Пока заглушка — в будущем здесь будет парсинг .icm / .cxf
  const mockMeasurements: Measurement[] = Array.from({ length: 500 }, (_, i) => ({
    SAMPLE_ID: `P${String(i + 1).padStart(4, '0')}`,
    CMYK_C: Math.random() * 100,
    CMYK_M: Math.random() * 100,
    CMYK_Y: Math.random() * 100,
    CMYK_K: Math.random() * 100,
    LAB_L: 50 + Math.random() * 50,
    LAB_A: -20 + Math.random() * 40,
    LAB_B: -20 + Math.random() * 40,
    spectra: Array.from({ length: 36 }, () => Math.random() * 0.9 + 0.05),
    wavelengths: Array.from({ length: 36 }, (_, i) => 380 + i * 10),
  }));

  const profileData: ProfileData = {
    metadata,
    raw: mockMeasurements,
    clean: [...mockMeasurements], // пока копия
    has_spectral: true,
    patch_count: mockMeasurements.length,
    average_deltaE_raw_clean: 0.85,
    wavelengths: Array.from({ length: 36 }, (_, i) => 380 + i * 10),
  };

  return profileData;
}

// Для множественной загрузки
export async function loadMultipleProfiles(files: FileList): Promise<ProfileData[]> {
  const promises = Array.from(files).map(file => loadProfile(file));
  return Promise.all(promises);
}