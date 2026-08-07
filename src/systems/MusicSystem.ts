import * as Tone from 'tone';

export class MusicSystem {
  // Effects
  private reverb!: Tone.Reverb;
  private compressor!: Tone.Compressor;

  // Pad
  private pad!: Tone.PolySynth;
  private padPart!: Tone.Part;

  // Drums
  private kick!: Tone.MembraneSynth;
  private kickPart!: Tone.Sequence;
  private snare!: Tone.NoiseSynth;
  private snarePart!: Tone.Sequence;
  private hats!: Tone.MetalSynth;
  private hatsPart!: Tone.Sequence;

  // Bass
  private bass!: Tone.Synth;
  private bassPart!: Tone.Part;

  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    Tone.getContext(); // Force real AudioContext creation within user gesture
    await Tone.start();

    // Shared effects
    this.reverb = new Tone.Reverb({ decay: 3, wet: 0.35 }).toDestination();
    await this.reverb.ready; // Wait for impulse response (Safari OfflineAudioContext)
    this.compressor = new Tone.Compressor({
      threshold: -20,
      ratio: 4,
      attack: 0.03,
      release: 0.25,
    }).connect(this.reverb);

    // ── Pad: warm chords ──
    this.pad = new Tone.PolySynth(Tone.Synth, {
      volume: -24,
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.8, decay: 1.5, sustain: 0.6, release: 2 },
    }).connect(this.reverb);

    // Cmaj7 → Am7 → Fmaj7 → G7  (2 bars each, 8-bar loop)
    this.padPart = new Tone.Part((time, event) => {
      this.pad.triggerAttackRelease(event.notes, event.dur, time);
    }, [
      { time: '0:0', notes: ['C3', 'E3', 'G3', 'B3'], dur: '2m' },
      { time: '2:0', notes: ['A2', 'C3', 'E3', 'G3'], dur: '2m' },
      { time: '4:0', notes: ['F2', 'A2', 'C3', 'E3'], dur: '2m' },
      { time: '6:0', notes: ['G2', 'B2', 'D3', 'F3'], dur: '2m' },
    ]);
    this.padPart.loop = true;
    this.padPart.loopEnd = '8m';
    this.padPart.start(0);

    // ── Kick: soft and round ──
    this.kick = new Tone.MembraneSynth({
      volume: -20,
      pitchDecay: 0.05,
      octaves: 4,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.002, decay: 0.3, sustain: 0, release: 0.1 },
    }).connect(this.compressor);

    this.kickPart = new Tone.Sequence((time, vel) => {
      if (vel) this.kick.triggerAttack('C1', time);
    }, [1, null, null, null, 1, null, null, 0.5], '8n').start(0);

    // ── Snare: soft vinyl-noise rimshot ──
    this.snare = new Tone.NoiseSynth({
      volume: -28,
      noise: { type: 'pink' },
      envelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.05 },
    }).connect(this.compressor);

    this.snarePart = new Tone.Sequence((time, vel) => {
      if (vel) this.snare.triggerAttackRelease('16n', time);
    }, [null, null, null, null, 1, null, null, null], '8n').start(0);

    // ── Hi-hats: gentle ticking ──
    this.hats = new Tone.MetalSynth({
      volume: -34,
      envelope: { attack: 0.001, decay: 0.03, release: 0.01 },
      harmonicity: 5.1,
      modulationIndex: 16,
      resonance: 5000,
      octaves: 0.5,
    }).connect(this.compressor);
    this.hats.frequency.value = 400;

    this.hatsPart = new Tone.Sequence((time, vel) => {
      if (vel && Math.random() < 0.6) {
        this.hats.triggerAttackRelease('32n', time);
      }
    }, [0.5, 0.3, 0.8, 0.3, 0.5, 0.3, 0.8, 0.3], '8n').start('4m');

    // ── Bass: warm sine with gentle attack ──
    this.bass = new Tone.Synth({
      volume: -20,
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.05, decay: 0.3, sustain: 0.4, release: 0.5 },
    }).connect(this.compressor);

    this.bassPart = new Tone.Part((time, event) => {
      if (Math.random() < event.prob) {
        this.bass.triggerAttackRelease(event.note, event.dur, time);
      }
    }, [
      // Bar 0–1: C root
      { time: '0:0',   note: 'C2', dur: '4n.', prob: 1 },
      { time: '0:2',   note: 'C2', dur: '8n',  prob: 0.5 },
      { time: '0:3',   note: 'G1', dur: '8n',  prob: 0.7 },
      { time: '1:0',   note: 'C2', dur: '4n.',  prob: 1 },
      { time: '1:3',   note: 'E2', dur: '8n',  prob: 0.6 },
      // Bar 2–3: Am root
      { time: '2:0',   note: 'A1', dur: '4n.', prob: 1 },
      { time: '2:2',   note: 'A1', dur: '8n',  prob: 0.5 },
      { time: '2:3',   note: 'E2', dur: '8n',  prob: 0.7 },
      { time: '3:0',   note: 'A1', dur: '4n.',  prob: 1 },
      { time: '3:3',   note: 'G1', dur: '8n',  prob: 0.6 },
      // Bar 4–5: F root
      { time: '4:0',   note: 'F1', dur: '4n.', prob: 1 },
      { time: '4:2',   note: 'F1', dur: '8n',  prob: 0.5 },
      { time: '4:3',   note: 'C2', dur: '8n',  prob: 0.7 },
      { time: '5:0',   note: 'F1', dur: '4n.',  prob: 1 },
      { time: '5:3',   note: 'A1', dur: '8n',  prob: 0.6 },
      // Bar 6–7: G root
      { time: '6:0',   note: 'G1', dur: '4n.', prob: 1 },
      { time: '6:2',   note: 'G1', dur: '8n',  prob: 0.5 },
      { time: '6:3',   note: 'D2', dur: '8n',  prob: 0.7 },
      { time: '7:0',   note: 'G1', dur: '4n.',  prob: 1 },
      { time: '7:3',   note: 'B1', dur: '8n',  prob: 0.6 },
    ]);
    this.bassPart.loop = true;
    this.bassPart.loopEnd = '8m';
    this.bassPart.start(0);

    Tone.getTransport().bpm.value = 80;
    this.initialized = true;
  }

  startMusic(): void {
    if (!this.initialized) return;
    Tone.getTransport().start();
  }

  stopMusic(): void {
    if (!this.initialized) return;
    Tone.getTransport().stop();
  }

  dispose(): void {
    if (!this.initialized) return;
    this.stopMusic();
    this.padPart.dispose();
    this.pad.dispose();
    this.kickPart.dispose();
    this.kick.dispose();
    this.snarePart.dispose();
    this.snare.dispose();
    this.hatsPart.dispose();
    this.hats.dispose();
    this.bassPart.dispose();
    this.bass.dispose();
    this.compressor.dispose();
    this.reverb.dispose();
    this.initialized = false;
  }
}
