# Deep Learning Models for Sleep Stage Classification

Date: 2026-03-14
Type: literature survey
Task: Survey DL models for sleep stage classification

## Summary

This survey covers deep learning approaches for automatic sleep stage classification (typically 5-class: Wake, N1, N2, N3, REM per AASM standards). Models are organized by architecture family. The field has evolved from CNN+RNN hybrids (2017-2019) to attention/Transformer-based architectures (2020-present), with recent emphasis on lightweight models for edge deployment and whole-cycle temporal modeling.

**Human expert baseline**: Inter-rater Cohen's kappa = 0.77 (meta-analysis). Per-stage kappa varies: W=0.70, N1=0.24, N2=0.57, N3=0.57, REM=0.69. N1 is consistently the hardest stage for both humans and models.

## Standard Benchmark Datasets

| Dataset | Subjects | Channels | Sampling Rate | Notes |
|---------|----------|----------|---------------|-------|
| Sleep-EDF-20 (SC) | 20 | EEG (Fpz-Cz), EOG | 100 Hz | Most cited benchmark |
| Sleep-EDF-78 (SC+ST) | 78 | EEG (Fpz-Cz), EOG | 100 Hz | Extended version |
| SHHS | ~6,000 | EEG, EOG, EMG, ECG, respiratory | 125 Hz | Largest public PSG dataset |
| MASS | 200 | Full PSG (20-ch EEG) | 256 Hz | Multi-site, multi-scorer |
| ISRUC-S3 | 10 | EEG, EOG, EMG, ECG | 200 Hz | Multi-channel |
| Physio2018 | ~1,000 | PSG multi-channel | Various | PhysioNet Challenge 2018 |

## Models by Architecture Family

### 1. CNN-Based

#### DeepSleepNet (Supratak et al., 2017)
- **Architecture**: Two-branch CNN (small + large filters) → BiLSTM for temporal context
- **Input**: Single-channel raw EEG (Fpz-Cz)
- **Key idea**: Multi-scale feature extraction captures both fine-grained and coarse temporal patterns
- **Performance**: Sleep-EDF-20: 82.0% ACC, κ=0.76
- **Parameters**: ~25M (large for the task)
- **Significance**: One of the first end-to-end DL models for sleep staging; established the CNN+RNN paradigm

#### TinySleepNet (Supratak & Guo, 2020)
- **Architecture**: Single-branch CNN → unidirectional LSTM
- **Input**: Single-channel raw EEG
- **Key idea**: Simplified DeepSleepNet architecture — reduced to ~6% of original parameters while maintaining competitive accuracy
- **Performance**: Sleep-EDF-20: ~85.4% ACC (improved over DeepSleepNet)
- **Parameters**: ~1.5M
- **Significance**: Demonstrated that simpler architectures suffice; practical for resource-constrained deployment

#### U-Time (Perslev et al., 2019)
- **Architecture**: U-Net-style fully convolutional encoder-decoder for temporal segmentation
- **Input**: Variable-length multi-channel signals (EEG, EOG)
- **Key idea**: Reframes sleep staging as dense time-series segmentation — segments arbitrarily long sequences then aggregates at 30-second epoch resolution
- **Performance**: Sleep-EDF-78: MF1=76.0%; strong cross-dataset generalization
- **Significance**: First to treat sleep staging as segmentation rather than classification; robust to varying input lengths

### 2. CNN+RNN Hybrids

#### IITNet (Seo et al., 2020)
- **Architecture**: Modified ResNet-50 → BiLSTM
- **Input**: Single-channel EEG decomposed into overlapping sub-segments
- **Key idea**: Sub-epoch decomposition increases temporal resolution within each 30-second window
- **Performance**: Sleep-EDF-20: 83.6% ACC, MF1=76.5%, κ=0.77
- **Significance**: Showed that intra-epoch temporal structure matters for classification

#### SeqSleepNet (Phan et al., 2019)
- **Architecture**: Hierarchical RNN with attention — epoch-level feature extraction via filterbank + RNN, then sequence-level RNN
- **Input**: Single-channel EEG (STFT/filterbank representation)
- **Key idea**: End-to-end sequence-to-sequence model; hierarchical attention captures both intra-epoch spectral and inter-epoch temporal structure
- **Performance**: MASS: 87.1% ACC, MF1=83.3%, κ=0.815
- **Significance**: Strong baseline for sequence modeling; foundation for L-SeqSleepNet

#### XSleepNet (Phan et al., 2022)
- **Architecture**: Multi-view CNN+RNN with adaptive view weighting
- **Input**: Raw signal + time-frequency representation (two views)
- **Key idea**: Learns to adaptively weight raw and spectral views during training; improves complementarity
- **Performance**: Pediatric PSG: 88.9% ACC (trained on pediatric data)
- **Significance**: Multi-view approach addresses the raw-vs-spectrogram debate; strong cross-domain results

### 3. Attention/Transformer-Based

#### AttnSleep (Eldele et al., 2021)
- **Architecture**: Multi-resolution CNN (MRCNN) + Adaptive Feature Recalibration (AFR) → Temporal Context Encoder with multi-head attention
- **Input**: Single-channel raw EEG
- **Key idea**: Multi-resolution feature extraction combined with attention-based temporal encoding; no RNN needed
- **Performance**: Sleep-EDF-20: ~83% ACC; Sleep-EDF-78: 81.3% ACC, MF1=75.1%, κ=0.74; SHHS: 84.2% ACC, κ=0.78
- **Significance**: Demonstrated attention can replace RNNs for temporal modeling in sleep staging

#### SleepTransformer (Phan et al., 2022)
- **Architecture**: Transformer encoder with epoch-level and sequence-level self-attention
- **Input**: Single-channel EEG
- **Key idea**: Pure Transformer architecture for sleep staging with built-in interpretability via attention weights and uncertainty quantification
- **Performance**: Sleep-EDF-78: 84.9% ACC (with transfer learning); reported 88.7% ACC in some configurations
- **Significance**: First pure Transformer for sleep staging; attention maps provide clinical interpretability

#### L-SeqSleepNet (Phan et al., 2023)
- **Architecture**: Extended SeqSleepNet with whole-cycle (~90 min) long-range context encoding
- **Input**: Single-channel EEG (works with scalp EEG, in-ear EEG, cEEGrid)
- **Key idea**: Models entire sleep cycle context (not just local epochs) — captures macro-structural transitions like REM cycling
- **Performance**: Consistent gains over SeqSleepNet across PSG and ear-EEG configurations
- **Significance**: Showed that whole-cycle context improves staging accuracy; works across diverse EEG form factors

#### SleepContextNet (referenced in multiple comparisons)
- **Architecture**: CNN + contextual attention
- **Input**: Single-channel EEG
- **Performance**: Sleep-EDF-20: 84.8% ACC, MF1=79.8%, κ=0.79; Sleep-EDF-78: 82.7% ACC, MF1=77.2%, κ=0.76; SHHS: 86.4% ACC, MF1=80.5%, κ=0.81

### 4. Lightweight/Edge Models

#### DetectsleepNet / SomnoNet (2024)
- **Architecture**: Multi-scale CNN → 6-layer BiGRU
- **Input**: Single-channel raw EEG
- **Key idea**: End-to-end design with a "tiny" variant (DetectsleepNet-tiny) at only 0.049M parameters — 6% of standard model size — retaining 99.3-99.5% accuracy
- **Performance**: SHHS: 88.0% ACC, κ=0.831; Physio2018: 80.9% ACC, κ=0.739
- **Significance**: Near-SOTA performance at extremely low parameter count; strong candidate for mobile deployment

#### MicroSleepNet (2023)
- **Architecture**: Lightweight CNN designed for mobile terminal deployment
- **Input**: Single-channel EEG
- **Key idea**: Optimized for real-time inference on resource-constrained devices
- **Significance**: Explicitly targets mobile deployment scenario

#### LWSleepNet (2023)
- **Architecture**: Lightweight attention-based model
- **Input**: Single-channel EEG
- **Key idea**: Attention mechanisms with minimal parameter overhead
- **Significance**: Balances accuracy and efficiency for embedded systems

### 5. Non-EEG Modality Models

#### ECG-SleepNet (2024)
- **Architecture**: Deep learning model for comprehensive sleep staging from ECG
- **Input**: Single-lead ECG
- **Key idea**: Uses HRV features and raw ECG morphology for sleep staging without EEG
- **Performance**: Competitive with ECG-based baselines
- **Significance**: Enables sleep staging from wearables (smartwatches, chest straps) without EEG

#### HRV-based LSTM (Sun et al., 2019)
- **Architecture**: LSTM network on heart rate variability features
- **Input**: HRV derived from ECG
- **Performance**: 77.0% ACC, κ=0.61 (292 participants, 584 nights)
- **Significance**: Validated on large dataset; shows feasibility of cardiac-only sleep staging

#### IHR-based DL (Sridhar et al., 2020)
- **Architecture**: CNN on instantaneous heart rate
- **Input**: IHR from ECG (SHHS + MESA, >10,000 nights)
- **Performance**: 77% ACC, κ=0.66 (4-class: wake, light, deep, REM)
- **Significance**: Trained on largest ECG sleep staging dataset to date; 4-class rather than 5-class

## Consolidated Benchmark Table (Sleep-EDF-20, single-channel EEG, 5-class)

| Model | Year | Type | ACC (%) | MF1 (%) | κ | Params |
|-------|------|------|---------|---------|---|--------|
| DeepSleepNet | 2017 | CNN+BiLSTM | 82.0 | 76.9 | 0.76 | ~25M |
| SeqSleepNet | 2019 | RNN+Attn | — | — | — | — |
| U-Time | 2019 | FCN (U-Net) | — | — | — | — |
| IITNet | 2020 | CNN+BiLSTM | 83.6 | 76.5 | 0.77 | — |
| TinySleepNet | 2020 | CNN+LSTM | ~85.4 | — | — | ~1.5M |
| AttnSleep | 2021 | CNN+Attn | ~83 | — | — | — |
| SleepTransformer | 2022 | Transformer | — | — | — | — |
| SleepContextNet | 2022 | CNN+Attn | 84.8 | 79.8 | 0.79 | — |
| ZleepAnlystNet | 2024 | CNN | 87.0 | 82.1 | 0.82 | — |

Note: Exact numbers vary by evaluation protocol (k-fold strategy, epoch selection). Cross-paper comparison should be interpreted cautiously.

## Key Trends and Findings

### Finding 1: Architecture convergence on CNN+Attention
The dominant paradigm is CNN for intra-epoch feature extraction + attention/Transformer for inter-epoch temporal context. Pure RNN sequence encoders are being replaced by attention mechanisms, which parallelize better and provide interpretability via attention weights.

### Finding 2: Temporal context window is a critical design choice
Models that capture longer temporal context consistently outperform epoch-level classifiers. The progression: single epoch (DeepSleepNet) → ~20 epochs (AttnSleep, SleepTransformer) → whole sleep cycle (L-SeqSleepNet). Longer context helps resolve ambiguous transitions (N1↔N2, N2↔REM).

### Finding 3: Model compression is viable with minimal accuracy loss
DetectsleepNet-tiny achieves 99.3-99.5% of full model accuracy with only 0.049M parameters. This suggests the sleep staging task is not inherently complex from a model capacity perspective — the signal contains strong discriminative features that can be captured by compact models.

### Finding 4: Non-EEG modalities plateau around 77% accuracy
ECG/HRV-based models consistently reach ~77% accuracy and κ~0.61-0.66 on 4-class staging. This is well below EEG-based models (82-88%) but may be sufficient for consumer sleep tracking. Audio-based sleep staging (the focus of this project) has even less literature — this gap is the research opportunity.

### Finding 5: N1 stage remains the hardest class across all models
N1 (light sleep transition) is consistently the worst-performing class due to its transient nature and spectral similarity to both wake and N2. Even human experts achieve only κ=0.24 for N1. Models that improve N1 detection tend to rely on longer temporal context or multi-modal input.

### Finding 6: Cross-dataset generalization remains challenging
Models trained on one dataset (e.g., Sleep-EDF) often degrade 5-10% when tested on another (e.g., SHHS). Domain adaptation, transfer learning, and multi-dataset training (as in U-Sleep) are active research areas.

## Relevance to Sleep-Audio Project

1. **Architecture choice**: For audio-based sleep staging, the CNN+Attention paradigm is the most promising starting point — CNNs extract spectral features from mel-spectrograms/MFCCs, attention captures temporal dynamics across epochs.
2. **Lightweight models**: DetectsleepNet-tiny's success at 0.049M parameters is encouraging for mobile deployment. Similar compression ratios should be achievable for audio-based models.
3. **Temporal context**: Whole-cycle modeling (L-SeqSleepNet approach) could be adapted to audio — breathing patterns have sleep-cycle-level periodicity.
4. **Performance ceiling**: EEG models reach 82-88% accuracy. Audio-based models should expect lower accuracy (comparable to or slightly above ECG/HRV ~77%), since audio captures respiratory information only, not neural activity.
5. **Training data gap**: Most models train on PSG datasets with EEG labels. Audio-based approaches will need either: (a) PSG datasets that also recorded audio, or (b) transfer learning from EEG-trained models to audio features.

## Sources

- Supratak et al. (2017). DeepSleepNet: a Model for Automatic Sleep Stage Scoring based on Raw Single-Channel EEG. IEEE TNSRE.
- Perslev et al. (2019). U-Time: A Fully Convolutional Network for Time Series Segmentation Applied to Sleep Staging. NeurIPS.
- Phan et al. (2019). SeqSleepNet: End-to-End Hierarchical Recurrent Neural Network for Sequence-to-Sequence Automatic Sleep Staging. IEEE TNSRE.
- Seo et al. (2020). IITNet: Intra- and Inter-Epoch Temporal Context Network for Automatic Sleep Staging. arXiv.
- Supratak & Guo (2020). TinySleepNet: An Efficient Deep Learning Model for Sleep Stage Scoring. IEEE EMBC.
- Sridhar et al. (2020). Deep learning for automated sleep staging using instantaneous heart rate. npj Digital Medicine.
- Eldele et al. (2021). AttnSleep: An Attention-based Deep Learning Approach for Sleep Stage Classification. IEEE TNSRE.
- Perslev et al. (2021). U-Sleep: resilient high-frequency sleep staging. npj Digital Medicine.
- Phan et al. (2022). SleepTransformer: Automatic Sleep Staging with Interpretability and Uncertainty Quantification. IEEE JBHI.
- Phan et al. (2022). XSleepNet: Multi-View Sequential Model for Automatic Sleep Staging. IEEE TPAMI.
- Phan et al. (2023). L-SeqSleepNet: Whole-cycle Long Sequence Modelling for Automatic Sleep Staging. IEEE TNSRE.
- Yang et al. (2023). LWSleepNet: A lightweight attention-based deep learning model for sleep staging. Digital Health.
- Li et al. (2023). MicroSleepNet: efficient deep learning model for mobile terminal real-time sleep staging. Frontiers in Neuroscience.
- Sun et al. (2024). ECG-SleepNet: Deep Learning-Based Comprehensive Sleep Stage Classification Using ECG Signals. arXiv.
- Jiang et al. (2024). ZleepAnlystNet: sleep stage scoring based on single-channel raw EEG. Scientific Reports.
- Wang et al. (2024). DetectsleepNet / SomnoNet: An Interpretable and Efficient Sleep Staging Algorithm. arXiv.
- Zhao et al. (2024). Automatic sleep stage classification using deep learning: signals, data representation, and neural networks. Artificial Intelligence Review.
