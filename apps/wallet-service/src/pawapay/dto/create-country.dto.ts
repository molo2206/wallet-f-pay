// create-country.dto.ts
export class CreateCountryDto {
  name!: string;
  code!: string;
  flag?: string;
  prefix?: string;
  // eslint-disable-next-line prettier/prettier
}