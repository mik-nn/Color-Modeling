// src/store/useProfileStore.ts
import { create } from 'zustand';
import { ProfileData, LinearityResult } from '../types';

interface ProfileState {
  // Все загруженные профили
  profiles: ProfileData[];
  
  // Выбранные для сравнения (максимум 2)
  selectedProfiles: ProfileData[];
  
  // Результаты анализа
  linearityResult: LinearityResult | null;
  
  // UI состояние
  isLoading: boolean;
  error: string | null;

  // Actions
  addProfiles: (newProfiles: ProfileData[]) => void;
  removeProfile: (fullName: string) => void;
  selectProfile: (profile: ProfileData, selected: boolean) => void;
  setSelectedProfiles: (profiles: ProfileData[]) => void;
  clearSelection: () => void;
  
  setLinearityResult: (result: LinearityResult | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  
  // Утилиты
  getProfileByName: (fullName: string) => ProfileData | undefined;
  canSelectMore: () => boolean;
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  profiles: [],
  selectedProfiles: [],
  linearityResult: null,
  isLoading: false,
  error: null,

  addProfiles: (newProfiles) => 
    set((state) => ({
      profiles: [...state.profiles, ...newProfiles],
      error: null,
    })),

  removeProfile: (fullName) =>
    set((state) => ({
      profiles: state.profiles.filter(p => p.metadata.full_name !== fullName),
      selectedProfiles: state.selectedProfiles.filter(p => p.metadata.full_name !== fullName),
      linearityResult: null, // сбрасываем анализ при удалении
    })),

  selectProfile: (profile, selected) =>
    set((state) => {
      if (selected) {
        if (state.selectedProfiles.length >= 2) return state;
        return {
          selectedProfiles: [...state.selectedProfiles, profile],
        };
      } else {
        return {
          selectedProfiles: state.selectedProfiles.filter(
            p => p.metadata.full_name !== profile.metadata.full_name
          ),
          linearityResult: null,
        };
      }
    }),

  setSelectedProfiles: (profiles) => set({ selectedProfiles: profiles }),

  clearSelection: () => set({ 
    selectedProfiles: [], 
    linearityResult: null 
  }),

  setLinearityResult: (result) => set({ linearityResult: result }),

  setLoading: (loading) => set({ isLoading: loading }),

  setError: (error) => set({ error }),

  getProfileByName: (fullName) => {
    return get().profiles.find(p => p.metadata.full_name === fullName);
  },

  canSelectMore: () => get().selectedProfiles.length < 2,
}));