# Serialization-only subset of the Cap'n Proto calculator sample (C++/pycapnp).
# Full Calculator is RPC (interfaces, promise pipelining); that is out of scope
# for this runtime. Expression / EvaluateRequest / EvaluateResponse exercise
# Float64, nested unions, composite List(Expression), and enum packing.
@0x85150b117366d14b;

enum Operator {
  add @0;
  subtract @1;
  multiply @2;
  divide @3;
}

struct Expression {
  # Mirrors Calculator.Expression from the official sample, with capability
  # fields replaced by pure-data Operator for call nodes.
  union {
    literal @0 :Float64;
    parameter @1 :UInt32;
    call :group {
      op @2 :Operator;
      params @3 :List(Expression);
    }
  }
}

struct EvaluateRequest {
  expression @0 :Expression;
}

struct EvaluateResponse {
  value @0 :Float64;
}
