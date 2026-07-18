# Doctoral Guide to Epidemiologic Methods Critique

Apply this sequence: **question -> target -> design -> assumptions -> estimator -> evidence -> inference -> next study**.

## 1. Question, target, and design

- Identify the unresolved epidemiologic uncertainty and its importance. Judge whether prior evidence supports the rationale and whether the design can answer the question.
- Classify the aim as descriptive, predictive, associational, or causal. Define the target population, outcome, time scale, and measure. For causal aims, specify eligibility, strategies, comparator, time zero, follow-up, contrast, and estimand.
- Identify units of observation, assignment, and analysis. Assess whether the randomized, observational, longitudinal, multilevel, quasi-experimental, or target-trial design fits the target.

## 2. Data source, population, and selection

- Describe the data source, purpose, period, linkage, coverage, and fitness. Trace target, source, eligible, enrolled, observed, and analyzed populations.
- State inclusion and exclusion criteria; assess cohort appropriateness, sampling, nonparticipation, exclusions, survivor selection, loss to follow-up, informative observation, and collider conditioning.
- For complex surveys, assess weights, strata, clusters, and design-based inference. Separate internal validity from generalizability and transportability; assess effect modification, selection weights, and positivity.

## 3. Measurement

- Define the key exposure or treatment, primary and secondary outcomes, confounders, and modifiers: versions, timing, construction, reliability, validity, and meaning.
- Assess differential, nondifferential, and dependent error; calibration, detection, surveillance, recall, proxy reporting, and time-varying measurement.
- Consider validation data, repeated measures, calibration, likelihood or Bayesian correction, and probabilistic bias analysis. Do not assume nondifferential error biases toward the null.

## 4. Causal structure and covariates

- State the causal structure, using subject knowledge and a DAG when useful. Assess exchangeability, positivity, consistency, interference, and treatment versions.
- Classify covariates as confounders, mediators, colliders, instruments, proxies, or post-treatment variables; assess overadjustment and residual confounding.
- Judge whether restriction, matching, standardization, regression, propensity methods, weighting, or doubly robust estimation fits the estimand. Examine timing, measurement, overlap, balance, extreme weights, and effective sample size.

## 5. Analysis and estimation

- Reconstruct the analytic sample, coding, covariate sets, interactions, stratification, model sequence, software, and variance method. Trace displayed estimates to these choices.
- Identify the estimator and scale: risk, rate, odds, prevalence, hazard, survival, difference, ratio, or standardized contrast. Assess interpretation and collapsibility.
- Examine functional form, dependence, overdispersion, proportionality, nonlinearity, sparse data, separation, influential observations, variance, multiplicity, model selection, and subgroup claims.
- Emphasize absolute and relative estimates, uncertainty, and epidemiologic importance. Compare alternative models only when their targets, assumptions, data needs, and interpretation are clear.

## 6. Results, tables, figures, and discussion

- Summarize principal results with denominators, estimates, uncertainty, scale, and horizon.
- Audit material tables and figures: axes, lines, points, reference groups, legends, units, intervals, footnotes, missing values, and denominators. Check arithmetic, consistency, sample-size changes, labels, precision, and discrepancies across abstract, text, tables, and figures.
- Compare displayed evidence with the authors' interpretation. Identify omissions, selective emphasis, causal overreach, unsupported subgroups, and plausible alternatives.
- Assess whether the discussion follows from the results and assumptions. Evaluate comparisons with prior studies in light of differences in population, design, measurement, estimand, and bias.

## 7. Longitudinal data and missingness

- Align eligibility, time zero, assignment, covariates, risk time, and outcome ascertainment. Assess immortal time, latency, reverse causation, and depletion of susceptibles.
- Distinguish baseline, cumulative, sustained, dynamic, and time-varying strategies. If treatment affects time-varying confounders, consider g-methods.
- For repeated outcomes, distinguish population-average, subject-specific, trajectory, transition, joint, and multistate targets; assess correlation and informative observation.
- Separate missing data, censoring, competing events, and truncation. State MCAR, MAR, MNAR, or independent-censoring assumptions; assess complete-case analysis, imputation, weighting, likelihood, Bayesian methods, and informative-missingness sensitivity.

## 8. Specialized designs

- For prediction, define prediction time, horizon, population, use, and error consequences; assess leakage, optimism, overfitting, calibration, discrimination, utility, and external or temporal validation.
- For heterogeneity, specify the scale; distinguish prespecified modification from discovery and assess multiplicity, shrinkage, power, and validation.
- For matching or weighting, assess target, balance, overlap, weights, trimming, and uncertainty.
- For instrumental variables, assess relevance, exchangeability, exclusion, monotonicity when used, and effect population.
- For difference-in-differences, regression discontinuity, interrupted time series, synthetic controls, and natural experiments, identify the counterfactual, design-specific assumptions, diagnostics, falsification tests, and scope of inference.

## 9. Robustness, reproducibility, and next steps

- Link each sensitivity analysis to a named threat and decision threshold. Distinguish model robustness from identification robustness; consider negative controls, alternative definitions or windows, specification analyses, quantitative bias analysis, bounds, E-values, and tipping points when justified.
- Check registration, protocol, deviations, selective reporting, code and data access, variable provenance, software, and applicable guidance such as STROBE, RECORD, CONSORT, TRIPOD, STARD, or PRISMA.
- Separate author-reported strengths and limitations from reviewer-identified issues. State what current data can address, what requires validation or new data, and what remains unidentified. If a method cannot be evaluated competently, state that limit without implying validity.
- Prioritize: **immediate reanalysis -> bias-focused validation -> independent replication -> stronger design -> definitive long-term study**. Rank proposals by consequential uncertainty, threat to inference, identifiability, feasibility and ethics, expected information gain, and value beyond the current study.
