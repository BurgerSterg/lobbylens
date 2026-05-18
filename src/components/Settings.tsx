import { useState } from "react";
import type { Settings } from "../types";
import { saveSettings } from "../store/settings";
import { invoke } from "@tauri-apps/api/core";

const REGIONS = [
  { value: "na", label: "North America" },
  { value: "eu", label: "Europe" },
  { value: "ap", label: "Asia Pacific" },
  { value: "kr", label: "Korea" },
];

interface Props {
  settings: Settings;
  onClose: () => void;
  onChange: (s: Settings) => void;
}

export default function SettingsPanel({ settings, onClose, onChange }: Props) {
  const [local, setLocal] = useState<Settings>(settings);

  function update(patch: Partial<Settings>) {
    setLocal(prev => ({ ...prev, ...patch }));
  }

  async function handleSave() {
    saveSettings(local);
    onChange(local);
    if (local.alwaysOnTop !== settings.alwaysOnTop) {
      await invoke("set_always_on_top", { value: local.alwaysOnTop });
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center">
      <div className="bg-gray-900 border border-gray-700 w-96 p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <div className="w-1 h-5 bg-red-500" />
            <h2 className="text-sm font-black uppercase tracking-widest">Settings</h2>
          </div>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-white text-lg">✕</button>
        </div>

        <div className="space-y-5">

          {/* Henrik API Key */}
          <div>
            <label className="text-xs font-bold uppercase tracking-wider text-gray-400 block mb-1.5">
              Henrik API Key
            </label>
            <input
              type="password"
              value={local.henrikApiKey}
              onChange={e => update({ henrikApiKey: e.target.value })}
              placeholder="Your Henrik API key"
              className="w-full bg-gray-800 border border-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
            />
          </div>

          {/* Region */}
          <div>
            <label className="text-xs font-bold uppercase tracking-wider text-gray-400 block mb-1.5">
              Region
            </label>
            <select
              value={local.region}
              onChange={e => update({ region: e.target.value })}
              className="w-full bg-gray-800 border border-gray-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
            >
              {REGIONS.map(r => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>

          {/* Refresh Rate */}
          <div>
            <label className="text-xs font-bold uppercase tracking-wider text-gray-400 block mb-1.5">
              Refresh Rate: {local.refreshRate / 1000}s
            </label>
            <input
              type="range"
              min={2000}
              max={30000}
              step={1000}
              value={local.refreshRate}
              onChange={e => update({ refreshRate: Number(e.target.value) })}
              className="w-full accent-red-500"
            />
            <div className="flex justify-between text-xs text-gray-600 mt-1">
              <span>2s</span>
              <span>30s</span>
            </div>
          </div>

          {/* Opacity */}
          <div>
            <label className="text-xs font-bold uppercase tracking-wider text-gray-400 block mb-1.5">
              Opacity: {Math.round(local.opacity * 100)}%
            </label>
            <input
              type="range"
              min={0.3}
              max={1}
              step={0.05}
              value={local.opacity}
              onChange={e => update({ opacity: Number(e.target.value) })}
              className="w-full accent-red-500"
            />
          </div>

          {/* Lobby notification sound */}
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold uppercase tracking-wider text-gray-400">
              Lobby load sound
            </label>
            <button
              type="button"
              onClick={() => update({ soundEnabled: !(local.soundEnabled ?? true) })}
              className={`w-12 h-6 relative transition-colors ${(local.soundEnabled ?? true) ? "bg-red-600" : "bg-gray-700"}`}
            >
              <div className={`absolute top-1 w-4 h-4 bg-white transition-all ${(local.soundEnabled ?? true) ? "left-7" : "left-1"}`} />
            </button>
          </div>

          {/* Always on Top */}
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold uppercase tracking-wider text-gray-400">
              Always on Top
            </label>
            <button
              type="button"
              onClick={() => update({ alwaysOnTop: !local.alwaysOnTop })}
              className={`w-12 h-6 relative transition-colors ${local.alwaysOnTop ? "bg-red-600" : "bg-gray-700"}`}
            >
              <div className={`absolute top-1 w-4 h-4 bg-white transition-all ${local.alwaysOnTop ? "left-7" : "left-1"}`} />
            </button>
          </div>

        </div>

        <div className="flex gap-3 mt-6">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 text-sm font-bold uppercase tracking-wider border border-gray-600 text-gray-400 hover:bg-gray-800 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="flex-1 px-4 py-2 text-sm font-bold uppercase tracking-wider bg-red-600 hover:bg-red-700 text-white transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
