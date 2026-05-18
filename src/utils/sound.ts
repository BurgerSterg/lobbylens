/** Short two-tone chime via Web Audio API (no external assets). */
export function playLobbyLoadedChime(): void {
  try {
    const ctx = new AudioContext();
    void ctx.resume();

    const scheduleTone = (frequency: number, startAt: number, durationSec: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = frequency;
      osc.connect(gain);
      gain.connect(ctx.destination);

      const peak = 0.14;
      const end = startAt + durationSec;
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);

      osc.start(startAt);
      osc.stop(end + 0.02);
    };

    const now = ctx.currentTime;
    scheduleTone(520, now, 0.12);
    scheduleTone(660, now + 0.13, 0.12);

    window.setTimeout(() => {
      void ctx.close();
    }, 450);
  } catch {
    /* ignore: autoplay / unsupported */
  }
}
