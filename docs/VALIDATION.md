# Validation and deployment gates — NOT COMPLETED

This is a review checklist, not a certificate, regulatory determination, or
proof that a system is suitable for patient-impacting decisions. Assign qualified
owners, evidence references, approval dates and local regulatory requirements to
every gate. The application reports `validation_status: not_validated`.

## Clinical and cold-chain domain review

- [ ] Define intended use, users and which decisions remain human-only.
- [ ] Identify each product's manufacturer-approved temperature/exposure limits.
- [ ] Have pharmacists/quality specialists approve excursion/quarantine/release
      procedures; the demo's <2°C / >8°C rules are not universally applicable.
- [ ] Establish a hazard analysis, missed-alarm consequences and fail-safe design.
- [ ] Obtain independent, adjudicated real incident/outcome data with documented
      sensor calibration, clock quality and collection provenance.
- [ ] Validate across clinics, refrigerators, seasons, feeders and patient-serving
      environments, with chronological and site-held-out testing.
- [ ] Measure sensitivity, lead time versus response time, false alarms per
      clinic-week, calibration, missingness and confidence intervals.
- [ ] Compare against deterministic temperature/outage rules and operational
      baselines; do not infer clinical value from synthetic model metrics.
- [ ] Establish acceptable risk thresholds and an independently reviewed pilot
      in shadow mode before any operational decision support.
- [ ] Obtain applicable regulatory/legal/privacy review and documented signoff.

## Engineering and security acceptance

- [ ] Use required authentication, TLS, managed secrets and MFA/OIDC.
- [ ] Add clinic-scoped authorization/tenancy and device credentials with rotation.
- [ ] Independently review authentication, token revocation, rate limiting,
      ingestion abuse protection and software supply chain.
- [ ] Commission physical sensors, redundant local alarms and grid telemetry.
- [ ] Test sensor disconnects, malicious timestamps, power outages and gateway
      store-and-forward without falsely reporting healthy status.
- [ ] Add actual notification delivery and test escalation/acknowledgement during
      network loss, provider outages and unresponsive staff.
- [ ] Deploy reliable workers, persistent queues, idempotent ingestion, transactional
      event handling, concurrency/load tests and failover.
- [ ] Establish tamper-evident audit retention, encrypted backups and a successful
      restore drill with defined recovery objectives.
- [ ] Register model/data/configuration versions and approve rollback/retraining.
- [ ] Validate live prediction/outcome joining and drift detection on mature labels.
- [ ] Complete accessibility, browser/device and usability testing with operators,
      including keyboard/screen readers, low bandwidth and reduced motion.
- [ ] Train staff on downtime procedures and test independent hardware alarms
      when this dashboard, database and network are all unavailable.

## Evidence record template

| Gate | Owner | Evidence reference | Result | Reviewer | Date |
|---|---|---|---|---|---|
| Example: independent temperature alarm | Unassigned | Not provided | Pending | Unassigned | — |

Engineering unit tests establish only the behaviors explicitly tested. They do
not complete clinical, regulatory, field-deployment or reliability validation.
