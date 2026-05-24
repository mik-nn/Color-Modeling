// src/components/ProfileList.tsx
import { ProfileData } from '../types';

interface ProfileListProps {
  profiles: ProfileData[];
  onRemove: (fullName: string) => void;
}

export default function ProfileList({
  profiles,
  onRemove,
}: ProfileListProps) {
  return (
    <div className="space-y-2 max-h-[calc(100vh-300px)] overflow-auto pr-2">
      {profiles.length === 0 ? (
        <p className="text-gray-500 text-sm italic">No profiles loaded yet</p>
      ) : (
        <>
          <p className="text-xs text-gray-500 mb-2">
            Use the Reference / Target dropdowns on the right to pick a pair.
          </p>
          {profiles.map((profile) => (
            <div
              key={profile.metadata.full_name}
              className="group p-4 rounded-xl border transition-all border-gray-800 hover:border-gray-700 bg-gray-900"
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

                <button
                  onClick={() => onRemove(profile.metadata.full_name)}
                  className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-500 text-xl leading-none"
                  title="Remove this profile"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
