import { NextResponse } from 'next/server';
import { modelSlug } from '../../lib/explorer';
export function GET(request:Request){
  const url=new URL(request.url); const name=url.searchParams.get('model');
  if(!name||name.length>256)return new Response('Model name required',{status:400});
  return NextResponse.redirect(new URL(`/models/${modelSlug(name)}`,url.origin),308);
}
