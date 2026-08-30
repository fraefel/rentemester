import { useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { ErrorState, Loading } from "../components/Feedback";

/** Small review surface: all changes are append-only and are made through the
 * reviewed API flows; this screen intentionally makes history visible. */
export function DimensionsView(){
  const {slug=""}=useParams(); const definitions=useAsync(()=>api.dimensionDefinitions(slug),[slug]); const members=useAsync(()=>api.dimensionMembers(slug),[slug]);
  if(definitions.loading||members.loading)return <Loading/>; if(definitions.error||members.error)return <ErrorState message={definitions.error??members.error??"Kunne ikke hente dimensioner"}/>;
  return <section><header className="page-head"><div><h2>Dimensioner</h2><p className="muted">Administrér og gennemgå append-only definitioner, medlemmer og deres historiske navne.</p></div></header><h3>Definitioner</h3><table><thead><tr><th>Id</th><th>Navn</th><th>Status</th><th>Hændelse</th></tr></thead><tbody>{definitions.data!.map(row=><tr key={row.id}><td>{row.dimension_id}</td><td>{row.name}</td><td>{row.status}</td><td>{row.event_type}</td></tr>)}</tbody></table><h3>Medlemmer</h3><table><thead><tr><th>Dimension</th><th>Id</th><th>Navn</th><th>Status</th><th>Hændelse</th></tr></thead><tbody>{members.data!.map(row=><tr key={row.id}><td>{row.dimension_id}</td><td>{row.member_id}</td><td>{row.name}</td><td>{row.status}</td><td>{row.event_type}</td></tr>)}</tbody></table></section>;
}
