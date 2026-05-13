// src/components/ProfileList.tsx
import { ProfileData } from '../types';

interface ProfileListProps {
  profiles: ProfileData[];
  selectedProfiles: ProfileData[];
  onSelect: (profile: ProfileData, selected: boolean) => void;
  onRemove: (fullName: string) => void;
}

export default function ProfileList({ 
  profiles, 
  selectedProfiles, 
  onSelect, 
  onRemove 
}: ProfileListProps) {
  return (
    <div className="space-y-2 max-h-[calc(100vh-300px)] overflow-auto pr-2">
      {profiles.length === 0 ? (
        <p className="text-gray-500 text-sm italic">Пока нет загруженных профилей</p>
      ) : (
        profiles.map((profile) => {
          const isSelected = selectedProfiles.some(p => 
            p.metadata.full_name === profile.metadata.full_name
          );

          return (
            <div
              key={profile.metadata.full_name}
              className={`group p-4 rounded-xl border transition-all ${
                isSelected 
                  ? 'border-blue-500 bg-blue-950/50' 
                  : 'border-gray-800 hover:border-gray-700 bg-gray-900'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">
                    {profile.metadata.substrate}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {profile.metadata.series} • {profile.metadata.printer}
                  </p>
                  <p className="text-xs text-gray-500">
                    {profile.patch_count} патчей • {profile.has_spectral ? 'Спектр' : 'LAB'}
                  </p>
                </div>

                <div className="flex flex-col items-end gap-2">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={(e) => onSelect(profile, e.target.checked)}
                    className="w-4 h-4 accent-blue-600"
                  />
                  <button
                    onClick={() => onRemove(profile.metadata.full_name)}
                    className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-500 text-xl leading-none"
                  >
                    ×
                  </button>
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}