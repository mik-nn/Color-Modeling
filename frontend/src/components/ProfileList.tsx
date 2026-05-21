// src/components/ProfileList.tsx
import { ProfileData } from '../types';
import { useProfileStore } from '../store/useProfileStore';

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
  onRemove,
}: ProfileListProps) {
  const canSelectMore = useProfileStore(state => state.canSelectMore);
  const atMax = !canSelectMore();

  return (
    <div className="space-y-2 max-h-[calc(100vh-300px)] overflow-auto pr-2">
      {profiles.length === 0 ? (
        <p className="text-gray-500 text-sm italic">No profiles loaded yet</p>
      ) : (
        <>
          <p className="text-xs text-gray-500 mb-2">
            Select up to 2 profiles to compare
            {atMax && (
              <span className="ml-1 text-yellow-400 font-medium">· 2/2 selected</span>
            )}
          </p>
          {profiles.map((profile) => {
            const isSelected = selectedProfiles.some(
              p => p.metadata.full_name === profile.metadata.full_name
            );
            const disableCheck = !isSelected && atMax;

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
                      {profile.metadata.series} · {profile.metadata.printer}
                    </p>
                    <p className="text-xs text-gray-500">
                      {profile.patch_count} patches · {profile.has_spectral ? 'Spectral' : 'Lab'}
                    </p>
                  </div>

                  <div className="flex flex-col items-end gap-2">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={disableCheck}
                      title={disableCheck ? 'Deselect a profile first' : undefined}
                      onChange={(e) => onSelect(profile, e.target.checked)}
                      className="w-4 h-4 accent-blue-600 disabled:opacity-40 disabled:cursor-not-allowed"
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
          })}
        </>
      )}
    </div>
  );
}
