import { UsageDimensionPage, dimensionMetadata } from '../../components/dashboard/UsageDimensionPage';
type Props={params:Promise<{slug:string}>;searchParams?:Promise<Record<string,string|string[]|undefined>>};
export async function generateMetadata({params,searchParams}:Props){return dimensionMetadata('model',(await params).slug,await searchParams??{});}
export default async function Page({params,searchParams}:Props){return <UsageDimensionPage kind="model" slug={(await params).slug} search={await searchParams??{}}/>;}
