export function calendarTargets(months=['2027-06','2027-07']) {
  if(!Array.isArray(months)||months.length>12||months.some(month=>typeof month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)))throw new Error('Invalid collection months');
  return [...new Set(months)].flatMap(month=>[
    ...['ATH/FCO','FCO/ATH'].map(route=>({source:'ryanair',month,url:`https://services-api.ryanair.com/farfnd/v4/oneWayFares/${route}/cheapestPerDay?outboundMonthOfDate=${month}-01&currency=EUR`})),
    ...['BEG/ATH','ATH/BEG'].map(route=>({source:'air_serbia',month,url:`https://www.airserbia.com/api/destination/flight-prices/${route}?year=${month.slice(0,4)}&month=${Number(month.slice(5))}&pos=GLOBAL`})),
  ]);
}
