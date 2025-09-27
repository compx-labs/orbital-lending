Got it — here’s a clean, concise **project overview in Markdown** you can drop straight into your `README.md`. It sets the stage before the parameter + checklist sections you already have.

---

# Orbital Lending

**Orbital Lending** is CompX’s next-generation lending protocol on Algorand.
It is designed around **stateless contracts** and a **modular rate model**, built to maximize transparency, efficiency, and composability across the ecosystem.

## 🌌 Key Features

* **LST-Centric Lending:**
  Native support for liquid staking tokens (LSTs), making staked assets more capital-efficient.
* **Composable Debt:**
  Loans are fully interoperable across the CompX ecosystem — collateral and debt can be tracked seamlessly.
* **Dynamic Rate Curves:**
  Supports multiple interest-rate models (kinked, linear, power, asymptotic) for different market behaviors.
* **Revenue Sharing:**
  A portion of interest income is shared with CompX staking pools, creating sustainable yield for the community.
* **Open & Transparent:**
  Contracts are open source, stateless, and designed for auditability from day one.

## 🚀 Why Another Lending Market?

Algorand currently has very limited lending infrastructure. Healthy ecosystems rely on **multiple active lending protocols** for resilience, competition, and innovation.
Orbital Lending fills this gap by:

* Providing **diverse rate models** for different asset classes.
* Offering **protocol revenue sharing** to incentivize long-term participation.
* Building with **stateless architecture** for reduced trust assumptions and stronger security.

---


# Lending Market Parameters

Below are the key parameters that define how a lending market operates. All values are expressed in **basis points (bps)**, where 100 bps = 1%.
Optional parameters are not live at launch but may be enabled in the future.

---

### **ltv_bps — Loan-to-Value (LTV)**

The maximum portion of your posted collateral you can borrow against.
*Example: 7,500 bps = 75%. Posting $100 collateral allows $75 debt.*
Higher LTV increases capital efficiency but reduces the safety buffer.

---

### **liq_threshold_bps — Liquidation Threshold**

The collateral ratio below which a position may be liquidated.
*Example: 8,500 bps = 85%.*
If your collateral falls under this level, liquidators can repay debt and seize collateral.
Always set above LTV to create a buffer.

---

### **origination_fee_bps — Origination Fee**

A one-time fee charged when opening or increasing a loan.
*Example: 100 bps = 1% of borrowed amount.*
Helps cover protocol overhead and discourages rapid churn.

---

### **protocol_share_bps — Protocol Revenue Share**

The portion of borrower interest that goes to the protocol.
*Example: 2,000 bps = 20%.*
Raising this increases treasury revenue but reduces supplier APY.

---

### **base_bps — Base APR**

The minimum borrowing rate at 0% utilization.
Ensures borrowers always pay something, even when liquidity is abundant.
*Typical: 50–200 bps (0.5–2%).*

---

### **util_cap_bps — Utilization Cap**

Maximum % of deposits that may be borrowed.
*Example: 8,000 bps = 80%.*
Leaves liquidity buffer for withdrawals and liquidations.

---

### **kink_norm_bps — Kink (Normalized)**

Where the rate curve changes slope, measured 0–10,000 across 0 → util_cap.
Below kink: rates rise gently. Above kink: rates rise more steeply.

---

### **slope1_bps — Pre-Kink Slope**

APR increase (added to base) from 0 → kink utilization.
Higher slope = more sensitive early curve.

---

### **slope2_bps — Post-Kink Slope**

APR increase from kink → cap.
Usually steeper than slope1 to strongly deter borrowing when liquidity is tight.

---

### **max_apr_bps — APR Ceiling** *(Future; not live at launch)*

Absolute maximum APR regardless of utilization.
*0 = no cap.*
Can protect borrowers from extreme spikes but reduces market-clearing power.

---

### **ema_alpha_bps — Utilization EMA Weight** *(Future; not live at launch)*

Weight (0–10,000) for smoothing utilization with an exponential moving average.
0 disables smoothing. Helps avoid jittery rates in volatile conditions.

---

### **max_apr_step_bps — APR Step Limit** *(Future; not live at launch)*

Maximum APR change allowed per accrual step.
0 disables limiting. Improves predictability by preventing sudden jumps.

---

### **prev_apr_bps — Previous APR** *(Future; not live at launch)*

Stored APR from the last accrual window, used for step-limiting logic.

---

### **util_ema_bps — Stored Utilization EMA** *(Future; not live at launch)*

Tracks the exponential moving average of utilization when smoothing is active.

---

### **rate_model_type — Rate Model Selector** *(Future; not live at launch)*

Selects interest-rate model:

* `0 = kinked` (default at launch)
* `1 = linear`
* `2 = power curve`
* `3 = asymptotic/scarcity`

---

### **power_gamma_q16 — Power-Curve Exponent** *(Future; not live at launch)*

Exponent γ for the power-curve model, in fixed-point Q16.16 format.
Values >1 make rates rise faster at higher utilization.

---

### **scarcity_K_bps — Scarcity Escalator Strength** *(Future; not live at launch)*

Controls steepness of the asymptotic rate curve near max utilization.
Higher values = stronger deterrent to borrowing in scarce liquidity conditions.

---

### **total_borrows — Total Borrowed Amount**

Aggregate of all outstanding borrower principal plus accrued interest.
Grows during accrual, shrinks on repayment or liquidation.

---

### **borrow_index_wad — Borrow Index**

A cumulative multiplier (starts at INDEX_SCALE) tracking total interest accrued.
Used to calculate precise loan balances:
`loan = principal × (current_index / entry_index)`

---

### **last_accrual_ts — Last Accrual Timestamp**

Ledger timestamp when borrow index was last updated.

---

### **last_apr_bps — Last Applied APR**

APR that applied during the last accrual window.
Useful for transparency and optional step-limiting logic.

---

# ✅ How to Propose a Market

When requesting a new market (or modification of an existing one), please suggest parameter values and reasoning. Below are recommended ranges and trade-offs.

---

### **Collateral Safety**

* **LTV:** 60–80% typical. Higher = more capital efficiency, less safety.
* **Liquidation Threshold:** 70–90% typical. Must exceed LTV. Wider gap = safer.

---

### **Fees & Revenue**

* **Origination Fee:** 0–100 bps typical. Discourages quick flips.
* **Protocol Share:** 10–30% typical. Balances treasury revenue with supplier yield.

---

### **Interest Rate Model**

* **Base APR:** 50–200 bps typical. Borrowers always pay something.
* **Utilization Cap:** 75–90% typical. Ensures withdrawal/liquidation buffer.
* **Kink Point:** 70–85% typical. Beyond this, rates rise faster.
* **Slope1:** 200–500 bps. Early utilization sensitivity.
* **Slope2:** 1,000–3,000 bps. Strong deterrent at high utilization.
* **Future Models:** Optional caps, smoothing, and alternative models not live at launch.

---

### **Internal Tracking**

Values like **borrow index**, **last APR**, and **timestamps** are protocol-maintained and require no governance input.

---

## 🔑 Trade-Offs

* **Capital Efficiency vs. Safety:** Higher LTV = more borrowing, more risk.
* **Supplier Yield vs. Borrower Cost:** Steeper curves reward suppliers, cost borrowers.
* **Protocol Revenue vs. User Incentives:** Higher protocol share benefits treasury but lowers supplier APY.
* **Liquidity Buffer:** Lower utilization caps ensure liquidity for withdrawals and liquidations.

---

## 👉 Proposal Checklist

When proposing a market:

1. **State the asset(s)** and why they’re suitable.
2. **Suggest parameters** (with reasoning).
3. **Highlight risks** (price volatility, liquidity).
4. **Specify model type** (default kinked, or future model later).

---

