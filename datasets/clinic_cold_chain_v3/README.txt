clinic_cold_chain_v3 - SIMULATED data. Same files and columns as v2, plus backup/SMS/priority changes.
Files: synthetic_clinic_data.csv (115,200 rows: 20 clinics x 240 days hourly), outage_events.csv, clinics.csv,
sms_log.csv (new), generate_clinic_data.py (seed 42).

BACKUP: only 5 of 20 clinics have a backup (clinics.csv has_backup). In about 12% of their outages the backup fails to start.
SMS (backup clinics only): when an outage starts the clinic is texted, e.g.
  "CLINIC 03: power is OFF. Your fridge stays cold for about 5.5 h. Is your backup power working? Reply 1 = YES, 2 = NO"
Hours in the message come from the holdover model (Newton's law, fridge alone). 85% reply; 3% tap the wrong button.
sms_log.csv: alert text, hours left, reply, reply time, whether the backup really was working, confirmation text.

PRIORITY (every hour, all clinics): slack = hours until the fridge reaches 8 C - travel time from the hub.
Smaller slack = more urgent; farther clinic wins ties. Before any reply only the fridge-alone holdover counts.
sms_state: normal / critical_no_sms (no backup) / critical_unconfirmed (texted, no reply yet) / needs_help (replied NO) /
backup_in_use (replied YES: backup hours added, moved below the urgent group) / backup_exhausted (battery used up, urgent again).
Columns: priority_rank (1 = most urgent), priority_rank_before_followup (ignores replies), priority_slack_h, hours_to_8c_priority.

Do NOT use breach_next_6h*, cold_chain_breach, true_fridge_temp_c, hours_until_unusable, sms_state, priority_* as outage-model inputs.
Limits: all simulated; reply behaviour, backup fault rate and the 3% outage rate are assumptions, not measurements.
