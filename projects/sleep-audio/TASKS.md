# sleep-audio - Next actions

## Phase 1: Literature survey

- [ ] Survey DL models for sleep stage classification [requires-opus] [skill: analyze] [zero-resource]
  Why: Need to understand the landscape of deep learning approaches (CNN, RNN, Transformer, hybrid) used for sleep stage prediction/classification across all modalities, then focus on audio-applicable architectures.
  Done when: Literature note covering ≥10 papers on DL-based sleep staging, organized by model family, with accuracy benchmarks and modality requirements documented.
  Priority: high

- [ ] Survey audio feature extraction for breathing/snoring analysis [requires-opus] [skill: analyze] [zero-resource]
  Why: Audio-based sleep monitoring depends on extracting discriminative features from respiratory sounds. Need to identify which features (mel-spectrogram, MFCC, spectral centroid, breathing rate periodicity, snoring event detection) are used in the literature and which best capture sleep stage transitions.
  Done when: Literature note covering ≥8 papers on respiratory audio feature processing, with a comparison table of feature types, extraction methods, and reported discriminative power.
  Priority: high

- [ ] Survey audio-based sleep stage models specifically [requires-opus] [skill: analyze] [zero-resource]
  Why: While many sleep staging models use EEG/PSG, a smaller body of work uses audio or audio-adjacent signals (breathing, body movement sounds). Need to identify this specific subset and assess current state-of-the-art.
  Done when: Literature note documenting all identified papers that perform sleep stage classification from audio/breathing signals, with dataset, model, and accuracy details.
  Priority: high

- [ ] Identify and catalog public sleep audio datasets [fleet-eligible] [skill: record] [zero-resource]
  Why: Model training requires labeled data. Need to find datasets with both audio recordings and PSG-annotated sleep stages, or breathing/snoring recordings with sleep stage labels.
  Done when: A datasets.md file listing ≥3 candidate datasets with access method, size, label format, and licensing info.
  Priority: high

- [ ] Write Phase 1 synthesis [requires-opus] [skill: analyze] [zero-resource]
  Why: After individual literature surveys are complete, need to synthesize findings into an actionable research direction — which models, features, and datasets to pursue in Phase 2.
  Done when: Synthesis document recommending top 2-3 model architectures, preferred feature set, and target dataset(s) with justification.
  Priority: medium
  [blocked-by: completion of above survey tasks]

## Phase 2: Model exploration (future)

- [ ] Design baseline experiment [requires-opus] [skill: design]
  Why: Need a concrete experimental setup to evaluate candidate models on a chosen dataset.
  Done when: EXPERIMENT.md with dataset, preprocessing pipeline, model configs, and evaluation metrics defined.
  Priority: medium
  [blocked-by: Phase 1 synthesis]

## Phase 3: Mobile feasibility (future)

- [ ] Assess on-device inference constraints [requires-opus] [skill: analyze] [zero-resource]
  Why: The target application is a mobile app. Need to evaluate model size, latency, and power constraints for real-time inference on iOS/Android.
  Done when: Analysis document with model size/latency benchmarks for candidate architectures on mobile hardware.
  Priority: low
  [blocked-by: Phase 2 baseline results]
