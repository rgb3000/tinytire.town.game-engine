import * as Tone from 'tone';

export class SoundEffectSystem {
  private chimeSynth!: Tone.PolySynth;
  private returnSynth!: Tone.PolySynth;
  private placeSynth!: Tone.Synth;
  private placeFilter!: Tone.Filter;
  private deleteSynth!: Tone.NoiseSynth;
  private deleteFilter!: Tone.Filter;
  private spawnSynth!: Tone.MembraneSynth;
  private warnSynth!: Tone.Synth;
  private warnFilter!: Tone.Filter;
  private strandedSynth!: Tone.Synth;
  private strandedFilter!: Tone.Filter;
  private errorSynth!: Tone.Synth;
  private errorFilter!: Tone.Filter;
  private gameOverSynth!: Tone.Synth;
  private gameOverFilter!: Tone.Filter;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    Tone.getContext(); // Force real AudioContext creation within user gesture
    await Tone.start();

    // Delivery chime
    this.chimeSynth = new Tone.PolySynth(Tone.Synth, {
      volume: -6,
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.01, decay: 0.3, sustain: 0, release: 0.2 },
    }).toDestination();

    // Home-return ping — soft ascending two-note sound
    this.returnSynth = new Tone.PolySynth(Tone.Synth, {
      volume: -10,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.01, decay: 0.2, sustain: 0, release: 0.15 },
    }).toDestination();

    // Road place — muffled soft tap
    this.placeFilter = new Tone.Filter(600, 'lowpass').toDestination();
    this.placeSynth = new Tone.Synth({
      volume: -20,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.002, decay: 0.08, sustain: 0, release: 0.03 },
    }).connect(this.placeFilter);

    // Road delete — noisy scrape
    this.deleteFilter = new Tone.Filter(2500, 'lowpass').toDestination();
    this.deleteSynth = new Tone.NoiseSynth({
      volume: -10,
      noise: { type: 'brown' },
      envelope: { attack: 0.005, decay: 0.12, sustain: 0, release: 0.04 },
    }).connect(this.deleteFilter);

    // Building spawn — deep kick thump
    this.spawnSynth = new Tone.MembraneSynth({
      volume: -8,
      pitchDecay: 0.03,
      octaves: 6,
      oscillator: { type: 'square4' },
      envelope: { attack: 0.001, decay: 0.25, sustain: 0, release: 0.05 },
    }).toDestination();

    // Demand warning chirp — soft bird-like chirp
    this.warnFilter = new Tone.Filter(4000, 'bandpass').toDestination();
    this.warnSynth = new Tone.Synth({
      volume: -18,
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.003, decay: 0.06, sustain: 0, release: 0.03 },
    }).connect(this.warnFilter);

    // Stranded car alert — descending two-tone alarm
    this.strandedFilter = new Tone.Filter(2000, 'bandpass').toDestination();
    this.strandedSynth = new Tone.Synth({
      volume: -14,
      oscillator: { type: 'square' },
      envelope: { attack: 0.005, decay: 0.15, sustain: 0, release: 0.1 },
    }).connect(this.strandedFilter);

    // Error / empty inventory — soft muted knock
    this.errorFilter = new Tone.Filter(400, 'lowpass').toDestination();
    this.errorSynth = new Tone.Synth({
      volume: -6,
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.005, decay: 0.1, sustain: 0, release: 0.05 },
    }).connect(this.errorFilter);

    // Game over — retro arcade descending jingle
    this.gameOverFilter = new Tone.Filter(1200, 'lowpass').toDestination();
    this.gameOverSynth = new Tone.Synth({
      volume: -4,
      oscillator: { type: 'square' },
      envelope: { attack: 0.01, decay: 0.3, sustain: 0.4, release: 0.3 },
    }).connect(this.gameOverFilter);

    this.initialized = true;
  }

  playDeliveryChime(): void {
    if (!this.initialized) return;
    this.chimeSynth.triggerAttackRelease(['C4', 'E4', 'G4'], '8n');
  }

  playHomeReturn(): void {
    if (!this.initialized) return;
    const now = Tone.now();
    this.returnSynth.triggerAttackRelease('E5', '16n', now);
    this.returnSynth.triggerAttackRelease('G5', '16n', now + 0.1);
  }

  private lastPlaceTime = 0;

  playRoadPlace(): void {
    if (!this.initialized) return;
    const now = Tone.now();
    // Ensure each trigger is strictly after the previous one (mono synth requirement)
    const t = Math.max(now, this.lastPlaceTime + 0.01);
    this.lastPlaceTime = t;
    this.placeSynth.triggerAttackRelease('C5', 0.05, t);
  }

  private lastDeleteTime = 0;

  playRoadDelete(): void {
    if (!this.initialized) return;
    const now = Tone.now();
    // Ensure each trigger is strictly after the previous one (mono synth requirement)
    const t = Math.max(now, this.lastDeleteTime + 0.01);
    this.lastDeleteTime = t;
    this.deleteSynth.triggerAttackRelease(0.10, t);
  }

  private lastSpawnTime = 0;

  playSpawn(): void {
    if (!this.initialized) return;
    const now = Tone.now();
    const t = Math.max(now, this.lastSpawnTime + 0.12);
    this.lastSpawnTime = t;
    this.spawnSynth.triggerAttack('C1', t);
  }

  private lastWarnTime = 0;

  playDemandWarning(): void {
    if (!this.initialized) return;
    const now = Tone.now();
    // Ensure each trigger is strictly after the previous one (mono synth requirement)
    const t = Math.max(now, this.lastWarnTime + 0.05);
    this.lastWarnTime = t + 0.07;
    // Two quick chirps with rising pitch, like a bird
    this.warnSynth.triggerAttackRelease('A5', 0.04, t);
    this.warnSynth.triggerAttackRelease('D6', 0.04, t + 0.07);
  }

  private lastStrandedTime = 0;

  playStrandedAlert(): void {
    if (!this.initialized) return;
    const now = Tone.now();
    if (now - this.lastStrandedTime < 0.2) return;
    this.lastStrandedTime = now;
    this.strandedSynth.triggerAttackRelease('E5', 0.1, now);
    this.strandedSynth.triggerAttackRelease('B4', 0.1, now + 0.12);
  }

  private lastErrorTime = 0;

  playError(): void {
    if (!this.initialized) return;
    const now = Tone.now();
    if (now - this.lastErrorTime < 0.15) return;
    this.lastErrorTime = now;
    this.errorSynth.triggerAttackRelease('G3', 0.08, now);
  }

  playGameOver(): void {
    if (!this.initialized) return;
    const now = Tone.now();
    this.gameOverSynth.triggerAttackRelease('E4', 0.2, now);
    this.gameOverSynth.triggerAttackRelease('D4', 0.2, now + 0.25);
    this.gameOverSynth.triggerAttackRelease('C4', 0.2, now + 0.5);
    this.gameOverSynth.triggerAttackRelease('B3', 0.5, now + 0.75);
  }

  dispose(): void {
    if (!this.initialized) return;
    this.chimeSynth.dispose();
    this.returnSynth.dispose();
    this.placeSynth.dispose();
    this.placeFilter.dispose();
    this.deleteSynth.dispose();
    this.deleteFilter.dispose();
    this.spawnSynth.dispose();
    this.warnSynth.dispose();
    this.warnFilter.dispose();
    this.strandedSynth.dispose();
    this.strandedFilter.dispose();
    this.errorSynth.dispose();
    this.errorFilter.dispose();
    this.gameOverSynth.dispose();
    this.gameOverFilter.dispose();
    this.initialized = false;
  }
}
