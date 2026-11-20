import { configuredAccountCurrencies, requiredAccountCurrencies } from './account-currencies';

describe('devises de chaque compte', () => {
  it('CDF et USD par défaut, configurable', () => {
    expect(configuredAccountCurrencies(undefined)).toEqual(['CDF', 'USD']);
    expect(configuredAccountCurrencies('usd, cdf, EUR, XXX')).toEqual(['USD', 'CDF', 'EUR']);
    expect(configuredAccountCurrencies('XXX')).toEqual(['CDF', 'USD']);
  });

  it('ajoute les devises du pays sans doublon ni devise inconnue', () => {
    expect(requiredAccountCurrencies(['CDF'], 'CDF,USD')).toEqual(['CDF', 'USD']);
    expect(requiredAccountCurrencies(['kes', 'USD', 'ABC'], 'CDF,USD')).toEqual(['CDF', 'USD', 'KES']);
    expect(requiredAccountCurrencies([], 'CDF,USD')).toEqual(['CDF', 'USD']);
  });
});
