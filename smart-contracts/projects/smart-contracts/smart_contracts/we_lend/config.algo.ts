import { arc4 } from "@algorandfoundation/algorand-typescript"


export class Oracle extends arc4.Struct<{
  address: arc4.Address
  contractAppId: arc4.UintN64
}> {}
