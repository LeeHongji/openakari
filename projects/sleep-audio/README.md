# Sleep-Audio: Audio-Based Sleep Stage Monitoring

Status: active
Mission: Investigate deep learning approaches for classifying sleep stages (Wake, REM, N1, N2, N3) from breathing and snoring audio, targeting real-time inference on mobile devices.
Done when: A validated model architecture is identified and benchmarked on public sleep audio datasets, with a feasibility assessment for real-time mobile deployment.

## Context

Sleep stage classification traditionally relies on polysomnography (PSG) — EEG, EOG, EMG sensors in a clinical setting. This project explores a non-invasive alternative: using a smartphone microphone to capture breathing and snoring sounds during sleep, then classifying sleep stages from audio features alone.

The research is structured in phases:
1. **Literature survey** — Comprehensive review of deep learning for sleep stage classification, audio feature extraction from respiratory sounds, and model architectures suitable for audio-based sleep analysis.
2. **Model exploration** — Identify and evaluate candidate architectures (CNN, RNN, Transformer-based) on public datasets.
3. **Mobile feasibility** — Assess real-time inference constraints (latency, model size, power consumption) for smartphone deployment.

### Application scenario

A mobile sleep monitoring app that:
- Records breathing/snoring audio via the phone's microphone during sleep
- Performs real-time sleep stage classification
- Provides users with sleep quality reports (sleep architecture, stage transitions)

## Research questions

1. Can breathing and snoring audio alone reliably distinguish the 5 standard sleep stages (Wake, REM, N1, N2, N3)?
2. Which audio features (spectral, temporal, periodicity) are most discriminative for sleep stage transitions?
3. Which model architectures achieve the best accuracy-latency tradeoff for on-device inference?
4. How does audio-only classification accuracy compare to PSG-based and wearable-based approaches?

## Log

### 2026-03-14 (session 10)

Task-selected: Survey DL models for sleep stage classification. Produced `knowledge/dl-sleep-staging-survey.md` — comprehensive literature note covering 17 papers across 5 architecture families (CNN, CNN+RNN hybrid, Attention/Transformer, Lightweight/Edge, Non-EEG modality). Key findings: (1) dominant paradigm is CNN feature extraction + attention-based temporal context, (2) model compression to 0.049M params achieves 99.3% of full accuracy (DetectsleepNet-tiny), (3) non-EEG modalities plateau ~77% vs 82-88% for EEG, (4) audio-based sleep staging has minimal literature — this is the research gap. Recommendation for sleep-audio: CNN+Attention on mel-spectrograms with whole-cycle temporal modeling.

### 2026-03-14

Project created. Mentor-initiated scaffold based on research plan: start with comprehensive literature survey on DL-based sleep stage classification from audio, then move to model exploration and mobile deployment feasibility.

## Open questions

- Which public datasets contain both sleep audio recordings and PSG-annotated sleep stages?
- What is the minimum audio segment duration needed for reliable stage classification?
- How robust are audio-based methods to environmental noise (partner, pets, ambient sounds)?
- What are the privacy implications of continuous audio recording during sleep?
