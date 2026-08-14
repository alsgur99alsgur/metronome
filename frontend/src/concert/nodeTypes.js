import Node from "./Node";
import TextNode from "./TextNode";

export const nodeTypes = {
  dbRead: Node,

  python: Node,

  opl: Node,

  dbWrite: Node,

  concert: Node,

  concertInput: Node,

  concertOutput: Node,

  cacheRead: Node,

  cacheWrite: Node,



  loopIn: Node,

  loopOut: Node,

  text: TextNode,
};
