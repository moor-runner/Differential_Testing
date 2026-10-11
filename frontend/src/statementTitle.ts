// A rename carries over to the statement only while its leading H1 still shows the previous title,
// so a heading the user wrote by hand is never overwritten.
export function retitleStatement(statement: string, previous: string, next: string) {
  const heading = /^(\s*#[ \t]+)(.*?)[ \t]*(?=\r?\n|$)/.exec(statement);
  if (!heading || heading[2] !== previous.trim()) return statement;
  return heading[1] + next.replace(/[\r\n]+/g, ' ') + statement.slice(heading[0].length);
}
