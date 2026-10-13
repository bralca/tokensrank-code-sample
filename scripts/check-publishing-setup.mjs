import './load-env.mjs';

export async function checkPublishingSetup() {
  for (const key of ['SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY']) {
    if (!process.env[key]) throw new Error(`Configure ${key} in .env.local.`);
  }
  const schema=process.env.SUPABASE_SCHEMA || 'public';
  const headers={apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Accept-Profile':schema,'Content-Profile':schema,'Content-Type':'application/json'};
  const checks=[
    ['legacy session columns','sessions?select=active_seconds,longest_active_seconds&limit=0'],
    ['profile summaries','profile_summary?select=metrics,sessions_count&limit=0'],
    ['publish queue','local_publish_jobs?select=run_id,phase&limit=0'],
    ['aggregate session counts','published_usage_session_counts?select=date,total_sessions&limit=0'],
    ['public rankings','rpc/count_usage_leaderboard',{}],
    ['sortable public rankings','rpc/query_usage_leaderboard_sorted',{p_limit:0}],
    ['public usage categories','public_usage_dimensions?select=kind,slug&limit=0'],
    ['profile evidence','published_profile_evidence?select=profile_id&limit=0'],
    ['model pricing','model_pricing?select=model_id&limit=1'],
  ];
  const failures=[];
  await Promise.all(checks.map(async ([label,path,body])=>{
    try {
      const response=await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`,{headers,method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
      const result=await response.json();
      if(!response.ok) failures.push(`${label}: ${result.message || `HTTP ${response.status}`}`);
      else if(label==='model pricing' && !result.length) failures.push('model pricing: reference catalog is empty; run the pricing sync.');
    } catch { failures.push(`${label}: Supabase could not be reached.`); }
  }));
  if(failures.length) throw new Error(`Publishing setup is incomplete in schema ${schema}:\n${failures.join('\n')}\nApply the database migrations before starting the public app. Pricing and existing usage should be preserved.`);
  return {schema,status:'ready'};
}
if(process.argv[1] && new URL(import.meta.url).pathname===process.argv[1]) {
  checkPublishingSetup().then((result)=>console.log(JSON.stringify(result))).catch((error)=>{console.error(error.message);process.exitCode=1;});
}
