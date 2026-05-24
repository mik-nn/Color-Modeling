// src/store/useProfileStore.ts
//
// Minimal store: profile loading + removal. Cross-substrate transfer view
// (TransferView) manages its own per-session UI state (ref/target/predictor/
// strategy selections, slider values, D7 toggle). Nothing else lives here.

import { create } from 'zustand';
import { ProfileData } from '../types';

interface ProfileState {
  profiles: ProfileData[];
  isLoading: boolean;
  error: string | null;

  addProfiles: (newProfiles: ProfileData[]) => void;
  removeProfile: (fullName: string) => void;

  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;

  getProfileByName: (fullName: string) => ProfileData | undefined;
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  profiles: [],
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
    })),

  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),

  getProfileByName: (fullName) =>
    get().profiles.find(p => p.metadata.full_name === fullName),
}));
