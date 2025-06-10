import { arc4 } from "@algorandfoundation/algorand-typescript"

export class TokenPrice extends arc4.Struct<{
  assetId: arc4.UintN64
  price: arc4.UintN64
  lastUpdated: arc4.UintN64
}> {}

export class OracleKey extends arc4.Struct<{
  assetId: arc4.UintN64
}> {}
