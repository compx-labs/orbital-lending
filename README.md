# Orbital Lending

Orbital Lending is a next-generation, fully stateless DeFi lending protocol built on the Algorand blockchain. It introduces an innovative architecture where each lending market is deployed as a standalone smart contract, offering permissionless composability, tokenized debt markets, and advanced oracle integrations.

## Key Features

* **Stateless Lending Markets**: Each asset pair (deposit/borrow) is isolated to its own smart contract, simplifying logic and ensuring security and flexibility.
* **LST Integration**: Deposits mint liquid staking tokens (LSTs), which can be used as collateral across any compatible Orbital Lending market.
* **Tokenized Debt**: Loans are represented by ARC-19 NFTs (loan receipts), containing dynamic metadata and updated debt status.
* **Permissionless Buyouts**: Any user can repay another’s debt and claim the underlying collateral by paying a buyout premium that scales with loan health.
* **Interest Accrual**: Loans accrue interest over time, shared between protocol revenue and LST holders.
* **Advanced Oracle Pricing**: Uses decentralized cumulative price data from approved oracle pools for accurate collateral valuation.

## Technologies Used

* **Algorand Smart Contracts (ASC1s)**
* **TypeScript + algorand-typescript (AVM 11)**
* **ARC-19 Compliant Loan Receipt NFTs**
* **Vite + Vitest for testing**
* **Remix (for front-end, in companion repo)**

## Repository Structure

* `contracts/` – Core smart contract source code
* `artifacts/` – Auto-generated clients and interfaces
* `tests/` – End-to-end integration tests
* `docs/` – Documentation and test plans

## Getting Started

1. Clone the repo
2. Install dependencies
3. Run tests with `pnpm test`
4. Deploy contracts using the included factory client

## Test Plan

Test coverage includes:

* Contract deployment and initialization
* Collateral asset addition and removal
* Deposit and LST issuance
* Borrow and loan receipt NFT creation
* Repayment and full/partial loan updates
* Buyout and liquidation logic

See [`docs/orbital_lending_test_plan.md`](./docs/orbital_lending_test_plan.md) for the full checklist.

---

For questions or contributions, please contact the CompX team or open a pull request.

**Built with precision by CompX** 🛰️
