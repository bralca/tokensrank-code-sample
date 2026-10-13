export function observedActivity(days:Array<{date:string;tokens_total:number}>) {
  const dates=[...new Set(days.filter(d=>d.tokens_total>0&&/^\d{4}-\d{2}-\d{2}$/.test(d.date)&&Number.isFinite(Date.parse(`${d.date}T00:00:00Z`))&&new Date(`${d.date}T00:00:00Z`).toISOString().slice(0,10)===d.date).map(d=>d.date))].sort();
  const weeks=new Set(dates.map(day=>{
    const value=new Date(`${day}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate()-(value.getUTCDay()+6)%7);
    return value.toISOString().slice(0,10);
  }));
  return {activeDays:dates.length,activeWeeks:weeks.size,first:dates[0]??null,last:dates.at(-1)??null};
}
