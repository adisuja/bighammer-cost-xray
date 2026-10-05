"""Generate the synthetic SAMPLE dataset (assets/sample.js) and the small
real-format test CSVs (test-data/*.csv). Deterministic. All names are invented.

Run: python3 dev/make_sample.py
"""
import csv, io, json, random, os

random.seed(42)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = "1234567890123456"

# ---------- per-job sample (query 2 shape) ----------
names = [
    ("nightly_orders_ingest", "jobs", 31800), ("customer_360_build", "ap", 27400),
    ("clickstream_sessionise", "jobs", 24100), ("finance_gl_reconcile", "ap", 16900),
    ("ml_feature_refresh", "serverless", 14200), ("inventory_snapshot_hourly", "jobs", 12600),
    ("marketing_attribution", "ap", 11800), ("dq_checks_hourly", "jobs", 9700),
    ("supplier_feed_merge", "jobs", 8800), ("churn_model_score", "serverless", 7900),
    ("pricing_engine_backfill", "ap", 7400), ("events_compaction", "jobs", 6900),
    ("hr_people_mart", "jobs", 5200), ("risk_exposure_daily", "ap", 4900),
    ("sap_extract_landing", "jobs", 4600), ("web_logs_parse", "jobs", 4100),
    ("forecast_weekly", "serverless", 3800), ("gdpr_erasure_sweep", "jobs", 3100),
    ("partner_api_sync", "ap", 2700), ("cost_tags_audit", "jobs", 2200),
    ("sandbox_test_job", "jobs", 1900), ("vacuum_optimise_all", "jobs", 1700),
    ("ad_hoc_export_q3", "jobs", 1300), ("geo_enrichment", "jobs", 1100),
]
jobs = []
for i, (n, kind, cost) in enumerate(names):
    cost = round(cost * random.uniform(0.96, 1.04), 2)
    runs = random.choice([90, 90, 180, 360, 2160, 13, 26, 540])
    if "hourly" in n: runs = 2160
    if "weekly" in n: runs = 13
    if n in ("ad_hoc_export_q3", "sandbox_test_job"): runs = random.choice([4, 7])
    fail_rate = random.choice([0.0, 0.01, 0.02, 0.03, 0.05, 0.08, 0.12])
    if n in ("customer_360_build", "clickstream_sessionise", "pricing_engine_backfill"): fail_rate = 0.11
    failed = int(round(runs * fail_rate))
    failed_cost = round(cost / runs * failed * random.uniform(0.7, 1.3), 2) if failed else 0.0
    # jobs on all-purpose clusters: Databricks bills the cluster, not the job, so nothing is
    # billed to the job id; query 2 estimates the cluster share as ap_cluster_cost instead
    ap = 0.0
    apc = round(cost * random.uniform(1.0, 1.12), 2) if kind == "ap" else 0.0
    if kind == "ap": cost, failed_cost = 0.0, 0.0
    sl = round(cost * random.uniform(0.9, 1.0), 2) if kind == "serverless" else 0.0
    sched = runs if n not in ("ad_hoc_export_q3", "sandbox_test_job") else 0
    jobs.append(dict(workspace_id=WS, job_id=str(684213000000000 + i * 7919), job_name=n, runs=runs,
                     failed_runs=failed, scheduled_runs=sched, list_cost=cost, failed_cost=failed_cost,
                     all_purpose_cost=ap, serverless_cost=sl, ap_cluster_cost=apc))

jobs_total = sum(j["list_cost"] for j in jobs)
ap_traced = sum(j["all_purpose_cost"] for j in jobs)
ap_cluster = sum(j["ap_cluster_cost"] for j in jobs)
sl_traced = sum(j["serverless_cost"] for j in jobs)
jobs_classic_traced = jobs_total - ap_traced - sl_traced

# ---------- spend summary (query 1 shape) ----------
P = {"JOBS": 0.15, "JOBS_PHOTON": 0.15, "JOBS_SL": 0.35, "AP": 0.55, "AP_PHOTON": 0.55,
     "SQL_SL": 0.70, "SQL_PRO": 0.55, "DLT": 0.36, "SERVING": 0.07, "PO": 0.65, "STORAGE": 0.023}
spend = []
def row(prod, sku, traced, priced, cost, price):
    spend.append(dict(billing_origin_product=prod, sku_name=sku, traced_to_job=str(traced).lower(),
                      priced=str(priced).lower(), currency_code="USD",
                      dbus=round(cost / price, 2) if price else 0, list_cost=round(cost, 2) if priced else ""))
row("JOBS", "PREMIUM_JOBS_COMPUTE", True, True, jobs_classic_traced * 0.78, P["JOBS"])
row("JOBS", "PREMIUM_JOBS_COMPUTE_(PHOTON)", True, True, jobs_classic_traced * 0.22, P["JOBS"])
row("JOBS", "PREMIUM_JOBS_SERVERLESS_COMPUTE_US_EAST_N_VIRGINIA", True, True, sl_traced, P["JOBS_SL"])
row("ALL_PURPOSE", "PREMIUM_ALL_PURPOSE_COMPUTE", False, True, 61240.18 + ap_cluster, P["AP"])
row("ALL_PURPOSE", "PREMIUM_ALL_PURPOSE_COMPUTE_(PHOTON)", False, True, 22975.40, P["AP"])
row("SQL", "PREMIUM_SERVERLESS_SQL_COMPUTE_US_EAST_N_VIRGINIA", False, True, 38410.77, P["SQL_SL"])
row("SQL", "PREMIUM_SQL_PRO_COMPUTE", False, True, 17862.05, P["SQL_PRO"])
row("DLT", "PREMIUM_DLT_ADVANCED_COMPUTE", False, True, 26930.62, P["DLT"])
row("MODEL_SERVING", "PREMIUM_SERVERLESS_REAL_TIME_INFERENCE_US_EAST_N_VIRGINIA", False, True, 9384.10, P["SERVING"])
row("PREDICTIVE_OPTIMIZATION", "PREMIUM_PREDICTIVE_OPTIMIZATION_US_EAST_N_VIRGINIA", False, True, 3122.48, P["PO"])
row("DEFAULT_STORAGE", "PREMIUM_DEFAULT_STORAGE_US_EAST_N_VIRGINIA", False, True, 1218.33, P["STORAGE"])
spend.append(dict(billing_origin_product="NETWORKING", sku_name="PREMIUM_NETWORKING_EGRESS_US_EAST_N_VIRGINIA",
                  traced_to_job="false", priced="false", currency_code="", dbus=0, list_cost=""))

# ---------- cluster CPU (query 3 shape) ----------
clusters = [
    ("0912-081455-shared-analytics-xl", "shared-analytics-xl", "UI", "r5d.4xlarge", 1460.2, 6120.4, 9.4, 22.8, 31480.55),
    ("0315-112040-ds-team-gpu", "ds-team-gpu", "UI", "g5.2xlarge", 612.5, 1225.0, 6.1, 18.5, 14210.90),
    ("0701-090312-etl-adhoc-large", "etl-adhoc-large", "API", "i3.4xlarge", 538.0, 3228.0, 14.2, 31.0, 12355.20),
    ("0822-150930-customer360-ap", "customer360-ap", "UI", "r5.2xlarge", 820.4, 4102.0, 17.8, 36.4, 24870.12),
    ("0420-071501-bi-extracts", "bi-extracts", "UI", "m5.2xlarge", 402.7, 805.4, 11.9, 27.3, 6044.80),
    ("1102-201744-finance-recon", "finance-recon", "API", "m5.4xlarge", 366.1, 1464.4, 24.6, 58.1, 15120.66),
    ("job-684213000007919-run", "job-clickstream-sessionise", "JOB", "c5.4xlarge", 702.0, 5616.0, 63.5, 91.2, 23110.40),
    ("job-684213000000000-run", "job-nightly-orders-ingest", "JOB", "i3.2xlarge", 810.0, 6480.0, 48.2, 86.0, 30420.00),
    ("job-684213000039595-run", "job-inventory-snapshot", "JOB", "m5.xlarge", 1080.0, 2160.0, 12.7, 29.9, 12080.30),
    ("job-684213000055433-run", "job-dq-checks-hourly", "JOB", "m5.large", 1080.0, 2160.0, 8.8, 19.6, 9310.20),
    ("job-684213000063352-run", "job-supplier-feed-merge", "JOB", "r5.xlarge", 300.0, 1200.0, 41.0, 77.5, 8420.00),
    ("0605-130044-sandbox-small", "sandbox-small", "UI", "m5.large", 41.5, 41.5, 4.2, 12.0, 210.35),
    ("dlt-execution-7f3a91c2", "dlt-orders-pipeline", "PIPELINE", "m5d.2xlarge", 1460.0, 4380.0, 35.4, 62.0, 21480.00),
    ("0211-104410-ml-training", "ml-training", "API", "r5.8xlarge", 210.0, 840.0, 71.3, 96.4, 9640.75),
]
cpu = [dict(workspace_id=WS, cluster_id=c[0], cluster_name=c[1], cluster_source=c[2], worker_node_type=c[3],
            hours_observed=c[4], worker_node_hours=c[5], avg_cpu_percent=c[6], p95_cpu_percent=c[7], list_cost=c[8])
       for c in clusters]

def to_csv(rows):
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()), lineterminator="\n")
    w.writeheader(); w.writerows(rows)
    return buf.getvalue()

with open(os.path.join(ROOT, "assets", "sample.js"), "w") as f:
    f.write("/* SAMPLE DATA. Synthetic, invented workloads for demonstration only. Generated by dev/make_sample.py */\n")
    f.write("window.XRAY_SAMPLE = " + json.dumps({"spend": to_csv(spend), "jobs": to_csv(jobs), "cpu": to_csv(cpu)}) + ";\n")

# ---------- small real-format test files: shuffled column order, odd header case, quoted numbers with commas ----------
td = os.path.join(ROOT, "test-data")
with open(os.path.join(td, "xray_query1_spend.csv"), "w", newline="") as f:
    w = csv.writer(f, quoting=csv.QUOTE_ALL)
    w.writerow(["LIST_COST", "Sku_Name", "billing_origin_product", "dbus", "traced_to_job", "priced", "currency_code"])
    w.writerow(["12,480.50", "PREMIUM_JOBS_COMPUTE", "JOBS", "83,203.33", "true", "true", "USD"])
    w.writerow(["15,950.25", "PREMIUM_ALL_PURPOSE_COMPUTE", "ALL_PURPOSE", "29,000.45", "false", "true", "USD"])
    w.writerow(["4,020.10", "PREMIUM_SERVERLESS_SQL_COMPUTE_US_EAST_N_VIRGINIA", "SQL", "5,743", "false", "true", "USD"])
    w.writerow(["", "PREMIUM_NETWORKING_EGRESS", "NETWORKING", "0", "false", "false", ""])
with open(os.path.join(td, "xray_query2_jobs.csv"), "w", newline="") as f:
    w = csv.writer(f, quoting=csv.QUOTE_MINIMAL)
    w.writerow(["job_name", "Job_ID", "workspace_id", "list_cost", "runs", "failed_runs", "failed_cost", "all_purpose_cost", "serverless_cost", "scheduled_runs", "AP_Cluster_Cost"])
    w.writerow(["orders, nightly (prod)", "111", WS, "8,120.40", "90", "4", "390.10", "0", "0", "90", "0"])
    w.writerow(["finance_recon", "222", WS, "0", "180", "9", "0", "0", "0", "180", "5,940.00"])
    w.writerow(["adhoc \"one off\" export", "333", WS, "1,250.00", "3", "1", "410.00", "0", "0", "0", "0"])
    w.writerow(["features", "444", WS, "3,110.10", "360", "0", "0", "0", "3,110.10", "360", "0"])
with open(os.path.join(td, "xray_query3_cpu.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["Cluster_Name", "cluster_id", "cluster_source", "worker_node_type", "workspace_id", "hours_observed", "worker_node_hours", "avg_cpu_percent", "p95_cpu_percent", "list_cost"])
    w.writerow(["finance-recon-ap", "0101-a", "UI", "m5.4xlarge", WS, "412.0", "1,648.0", "11.2", "26.5", "6,600.00"])
    w.writerow(["etl-big", "0101-b", "JOB", "i3.2xlarge", WS, "300.5", "1,202.0", "55.0", "88.0", "8,120.40"])
    w.writerow(["tiny-test", "0101-c", "UI", "m5.large", WS, "0.4", "0.4", "2.0", "5.0", "3.10"])

print("ap cluster est", round(ap_cluster, 2))
print("jobs total", round(jobs_total, 2), "ap traced", round(ap_traced, 2), "sl", round(sl_traced, 2))
print("spend total", round(sum(float(r["list_cost"] or 0) for r in spend), 2))
