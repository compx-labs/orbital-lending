
# ✅ Orbital Lending Test Plan

## ⚙️ 1. Contract Deployment & Configuration
- [x] Deploy xusd contract with manager account  
- [x] Deploy algo contract with manager account  
- [x] Create base token ASA - xUSD
- [x] Initialize xusd contract with MBR and parameters 
- [x] create cAlgo lst for use in algo contract
- [x] Initialize algo contract with MBR and parameters   
- [x] Validate global state (LTV, interest, fees, etc.)  
- [x] Confirm LST is created correctly and ASA opt-in done

## 🧱 2. Collateral & Oracle Setup
- [x] Add valid oracle pool (with dummy or real LP data)  
- [x] Confirm oracle state stored correctly  
- [x] Add accepted collateral token  
- [x] Validate collateral config and opt-in  
- [x] Prevent duplicate or invalid collateral entries  

## 💰 3. Deposits & Withdrawals
- [x] Deposit base token into protocol  
- [ ] Receive LST correctly based on deposit ratio  
- [x] Withdraw deposit (LST burn → ASA returned)  
- [x] Confirm balances after deposit/withdraw  
- [ ] Test calculateASADue and calculateLSTDue logic  

## 🏦 4. Borrowing
- [ ] Attempt borrow with unsupported collateral (fail)  
- [ ] Successful borrow with supported collateral  
- [ ] LTV limits enforced on new loan  
- [ ] Origination fee deducted correctly  
- [ ] Loan record ASA created (ARC19 metadata correct)  
- [ ] Borrow multiple times to top up loan  
- [ ] Old loan record ASA burned and new issued  

## 📈 5. Interest Accrual
- [ ] Accrue interest correctly based on delta time  
- [ ] Depositor share increases `total_deposits`  
- [ ] Protocol share added to `fee_pool`  
- [ ] Loan record updated with new debt value  
- [ ] LST value shifts accordingly post-accrual  

## ♻️ 6. Repayment
- [ ] Repay partial debt (loan ASA replaced)  
- [ ] Repay full debt (collateral returned, loan deleted)  
- [ ] Cannot repay more than owed  
- [ ] Loan box deleted and `active_loan_records` decremented  

## 🔓 7. Liquidation
- [ ] Attempt liquidation above threshold (should fail)  
- [ ] Successful liquidation when CR drops below threshold  
- [ ] Clawback loan ASA and collateral  
- [ ] Protocol retains loan value  
- [ ] Collateral transferred to liquidator  

## 🪙 8. Buyouts (Secondary Market)
- [ ] Accrue interest before buyout  
- [ ] Calculate buyout price (collateral + premium scaling with CR)  
- [ ] Premium scales with CR (no max cap)  
- [ ] Loan ASA metadata updated post-buyout  
- [ ] Collateral remains locked but new borrower is set  
- [ ] Handle re-buyout or multiple transfers correctly  

## 📊 9. Read Methods & Frontend Helpers
- [ ] `getLoanRecord` returns full LoanRecord  
- [ ] `getLoanStatus` returns health, CR, LTV, liquidation eligibility  
- [ ] `getOraclePrice` & `getPricesFromOracles` return correct average  
- [ ] Test invalid scenarios (no oracle, no collateral, etc.)  

## 🧪 10. Full Flow Integration Test
- [ ] Add collateral and oracle  
- [ ] Deposit ASA → receive LST  
- [ ] Borrow → accrue interest → repay  
- [ ] Liquidate a failing position  
- [ ] Execute a buyout  
- [ ] Withdraw remaining fees as admin
