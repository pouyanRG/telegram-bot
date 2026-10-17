import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { connect_timeout: 30, prepare: false });
console.log(await sql`
  select column_name, data_type from information_schema.columns
  where table_schema = 'public' and table_name = 'users' order by ordinal_position
`);
await sql.end();