/* eslint-disable prettier/prettier */
export class CreateNetworkDto {
  name!: string;
  currency!: string;
  pourcentage_deposit!: number;
  pourcentage_payout!: number;
  image?: string;
  countryId!: string;
}