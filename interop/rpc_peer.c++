// Reference RPC peer for the lifecycle, promise, cancellation and
// embargo interop tests.
//
//   rpc_peer serve <port>            serve Echo at 127.0.0.1:<port>
//   rpc_peer client <port> [name..]  dial a TypeScript Echo and run scenarios
//
// Every scenario prints "ok <name>" on success and aborts the process on
// the first failed expectation, so the orchestrating script only needs the
// exit status.
#include "interop.capnp.h"
#include <capnp/ez-rpc.h>
#include <kj/async.h>
#include <kj/debug.h>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <string>
#include <unistd.h>
#include <vector>

namespace {

unsigned released = 0;
unsigned cancelled = 0;
unsigned uncancelableDone = 0;

class CounterImpl final : public Counter::Server {
public:
	~CounterImpl() noexcept(true) { ++released; }
	kj::Promise<void> inc(IncContext ctx) override {
		ctx.getResults().setN(ctx.getParams().getN() + 1);
		return kj::READY_NOW;
	}
};

class SinkImpl final : public Sink::Server {
public:
	SinkImpl(uint32_t failAfter) : failAfter(failAfter) {}

	kj::Promise<void> write(WriteContext ctx) override {
		++count;
		if (failAfter > 0 && count > failAfter) {
			kj::throwFatalException(KJ_EXCEPTION(OVERLOADED, "sink full"));
		}
		total += ctx.getParams().getData().size();
		return kj::READY_NOW;
	}

	kj::Promise<void> done(DoneContext ctx) override {
		ctx.getResults().setTotal(total);
		return kj::READY_NOW;
	}

private:
	uint32_t failAfter;
	uint32_t count = 0;
	uint64_t total = 0;
};

class KeepImpl final : public Keep::Server {
public:
	kj::Promise<void> value(ValueContext ctx) override {
		ctx.getResults().setN(7);
		return kj::READY_NOW;
	}
	kj::Promise<void> save(SaveContext ctx) override {
		ctx.getResults().setSturdyRef(kj::str("ref-for-", ctx.getParams().getSealFor()));
		return kj::READY_NOW;
	}
};

class EchoImpl final : public Echo::Server {
public:
	kj::Promise<void> ping(PingContext ctx) override {
		ctx.getResults().setN(ctx.getParams().getN() + 1);
		return kj::READY_NOW;
	}

	kj::Promise<void> makeCounter(MakeCounterContext ctx) override {
		ctx.getResults().setCounter(kj::heap<CounterImpl>());
		return kj::READY_NOW;
	}

	kj::Promise<void> makePromise(MakePromiseContext ctx) override {
		auto paf = kj::newPromiseAndFulfiller<Counter::Client>();
		counterFulfiller = kj::mv(paf.fulfiller);
		ctx.getResults().setCounter(Counter::Client(kj::mv(paf.promise)));
		return kj::READY_NOW;
	}

	kj::Promise<void> resolveLater(ResolveLaterContext) override {
		KJ_IF_MAYBE(f, counterFulfiller) {
			(*f)->fulfill(kj::heap<CounterImpl>());
			counterFulfiller = nullptr;
		}
		return kj::READY_NOW;
	}

	kj::Promise<void> slow(SlowContext ctx) override {
		auto paf = kj::newPromiseAndFulfiller<void>();
		gates.add(kj::mv(paf.fulfiller));
		auto done = std::make_shared<bool>(false);
		return paf.promise
		    .then([ctx, done]() mutable {
			    *done = true;
			    ctx.getResults().setN(99);
		    })
		    .attach(kj::defer([done]() {
			    if (!*done) ++cancelled;
		    }));
	}

	kj::Promise<void> slowUncancelable(SlowUncancelableContext ctx) override {
		auto paf = kj::newPromiseAndFulfiller<void>();
		gates.add(kj::mv(paf.fulfiller));
		return paf.promise.then([ctx]() mutable {
			ctx.getResults().setN(99);
			++uncancelableDone;
		});
	}

	kj::Promise<void> unblock(UnblockContext) override {
		for (auto& g : gates) g->fulfill();
		gates.clear();
		return kj::READY_NOW;
	}

	kj::Promise<void> stats(StatsContext ctx) override {
		auto r = ctx.getResults();
		r.setCancelled(cancelled);
		r.setReleased(released);
		r.setCompletedUncancelable(uncancelableDone);
		return kj::READY_NOW;
	}

	kj::Promise<void> callBack(CallBackContext ctx) override {
		auto req = ctx.getParams().getCap().incRequest();
		req.setN(ctx.getParams().getN());
		return req.send().then([ctx](auto r) mutable { ctx.getResults().setN(r.getN()); });
	}

	kj::Promise<void> echoCap(EchoCapContext ctx) override {
		ctx.getResults().setCap(ctx.getParams().getCap());
		return kj::READY_NOW;
	}

	kj::Promise<void> fail(FailContext) override {
		kj::throwFatalException(KJ_EXCEPTION(OVERLOADED, "busy on purpose"));
	}

	kj::Promise<void> brokenCap(BrokenCapContext ctx) override {
		ctx.getResults().setCap(Counter::Client(capnp::newBrokenCap("broken on purpose")));
		return kj::READY_NOW;
	}

	kj::Promise<void> hold(HoldContext ctx) override {
		held = ctx.getParams().getCap();
		return kj::READY_NOW;
	}

	kj::Promise<void> callHeld(CallHeldContext ctx) override {
		auto req = held.incRequest();
		req.setN(ctx.getParams().getN());
		return req.send().then([ctx](auto r) mutable { ctx.getResults().setN(r.getN()); });
	}

	kj::Promise<void> promiseOfHeld(PromiseOfHeldContext ctx) override {
		auto paf = kj::newPromiseAndFulfiller<Counter::Client>();
		heldFulfiller = kj::mv(paf.fulfiller);
		ctx.getResults().setCap(Counter::Client(kj::mv(paf.promise)));
		return kj::READY_NOW;
	}

	kj::Promise<void> resolveHeld(ResolveHeldContext) override {
		KJ_IF_MAYBE(f, heldFulfiller) {
			(*f)->fulfill(kj::cp(held));
			heldFulfiller = nullptr;
		}
		return kj::READY_NOW;
	}

	kj::Promise<void> openSink(OpenSinkContext ctx) override {
		ctx.getResults().setSink(kj::heap<SinkImpl>(ctx.getParams().getFailAfter()));
		return kj::READY_NOW;
	}

	kj::Promise<void> openKeep(OpenKeepContext ctx) override {
		ctx.getResults().setKeep(kj::heap<KeepImpl>());
		return kj::READY_NOW;
	}

	kj::Promise<void> die(DieContext) override {
		std::cout.flush();
		_exit(0);
	}

private:
	kj::Maybe<kj::Own<kj::PromiseFulfiller<Counter::Client>>> counterFulfiller;
	kj::Maybe<kj::Own<kj::PromiseFulfiller<Counter::Client>>> heldFulfiller;
	kj::Vector<kj::Own<kj::PromiseFulfiller<void>>> gates;
	Counter::Client held = nullptr;
};

void ok(const char *name) {
	std::cout << "ok " << name << std::endl;
}

bool wants(const std::vector<std::string> &only, const char *name) {
	if (only.empty()) return true;
	for (auto &o : only) if (o == name) return true;
	return false;
}

// Scenarios that dial a TypeScript Echo. The TypeScript side counts what
// it observes and reports it through stats, so each check reads both what
// this peer saw and what the vat did.
void runClient(const std::string &addr, const std::vector<std::string> &only) {
	capnp::EzRpcClient client(addr);
	auto &ws = client.getWaitScope();
	Echo::Client echo = client.getMain<Echo>();

	if (wants(only, "ping")) {
		auto r = echo.pingRequest();
		r.setN(41);
		KJ_REQUIRE(r.send().wait(ws).getN() == 42);
		ok("ping");
	}

	if (wants(only, "pipeline")) {
		auto call = echo.makeCounterRequest().send();
		auto inc = call.getCounter().incRequest();
		inc.setN(1);
		KJ_REQUIRE(inc.send().wait(ws).getN() == 2);
		ok("pipeline");
	}

	if (wants(only, "promise")) {
		auto p = echo.makePromiseRequest().send();
		auto counter = p.getCounter();
		auto inc = counter.incRequest();
		inc.setN(5);
		auto early = inc.send();
		echo.resolveLaterRequest().send().wait(ws);
		KJ_REQUIRE(early.wait(ws).getN() == 6);
		auto later = counter.incRequest();
		later.setN(7);
		KJ_REQUIRE(later.send().wait(ws).getN() == 8);
		ok("promise");
	}

	if (wants(only, "exception")) {
		bool failed = false;
		KJ_IF_MAYBE(e, kj::runCatchingExceptions([&]() { echo.failRequest().send().wait(ws); })) {
			failed = true;
			KJ_REQUIRE(e->getType() == kj::Exception::Type::OVERLOADED, e->getType());
			KJ_REQUIRE(std::string(e->getDescription().cStr()).find("busy on purpose") != std::string::npos,
			           e->getDescription());
		}
		KJ_REQUIRE(failed, "fail() did not fail");
		ok("exception");
	}

	if (wants(only, "broken")) {
		auto cap = echo.brokenCapRequest().send().wait(ws).getCap();
		bool failed = false;
		KJ_IF_MAYBE(e, kj::runCatchingExceptions([&]() { cap.incRequest().send().wait(ws); })) {
			failed = true;
			KJ_REQUIRE(std::string(e->getDescription().cStr()).find("broken on purpose") !=
			           std::string::npos, e->getDescription());
		}
		KJ_REQUIRE(failed, "a broken capability accepted a call");
		ok("broken");
	}

	if (wants(only, "callback")) {
		unsigned calls = 0;
		class Mine final : public Counter::Server {
		public:
			Mine(unsigned &calls) : calls(calls) {}
			kj::Promise<void> inc(IncContext ctx) override {
				++calls;
				ctx.getResults().setN(ctx.getParams().getN() + 100);
				return kj::READY_NOW;
			}
			unsigned &calls;
		};
		auto req = echo.callBackRequest();
		req.setCap(kj::heap<Mine>(calls));
		req.setN(4);
		KJ_REQUIRE(req.send().wait(ws).getN() == 104);
		KJ_REQUIRE(calls == 1);
		ok("callback");
	}

	if (wants(only, "capfail")) {
		// Pass a capability parameter to a call that throws on the server,
		// then verify the connection is still healthy (no double-release abort).
		class Throwing final : public Counter::Server {
		public:
			kj::Promise<void> inc(IncContext) override {
				kj::throwFatalException(KJ_EXCEPTION(OVERLOADED, "counter busy"));
			}
		};
		bool failed = false;
		KJ_IF_MAYBE(e, kj::runCatchingExceptions([&]() {
			auto req = echo.callBackRequest();
			req.setCap(kj::heap<Throwing>());
			req.setN(1);
			req.send().wait(ws);
		})) {
			failed = true;
			KJ_REQUIRE(e->getType() == kj::Exception::Type::OVERLOADED, e->getType());
		}
		KJ_REQUIRE(failed, "callBack with throwing cap did not fail");
		auto ping = echo.pingRequest();
		ping.setN(10);
		KJ_REQUIRE(ping.send().wait(ws).getN() == 11);
		ok("capfail");
	}

	if (wants(only, "tailcall")) {
		// Server forwards callHeld() via ctx.tailCall (sendResultsTo.yourself +
		// takeFromOtherQuestion) back to our local Counter, on success and failure.
		class Mine final : public Counter::Server {
		public:
			kj::Promise<void> inc(IncContext ctx) override {
				ctx.getResults().setN(ctx.getParams().getN() + 100);
				return kj::READY_NOW;
			}
		};
		auto hold = echo.holdRequest();
		hold.setCap(kj::heap<Mine>());
		hold.send().wait(ws);
		auto call = echo.callHeldRequest();
		call.setN(4);
		KJ_REQUIRE(call.send().wait(ws).getN() == 104);

		class Failing final : public Counter::Server {
		public:
			kj::Promise<void> inc(IncContext) override {
				kj::throwFatalException(KJ_EXCEPTION(OVERLOADED, "tail boom"));
			}
		};
		auto hold2 = echo.holdRequest();
		hold2.setCap(kj::heap<Failing>());
		hold2.send().wait(ws);
		bool failed = false;
		KJ_IF_MAYBE(e, kj::runCatchingExceptions([&]() {
			auto c2 = echo.callHeldRequest();
			c2.setN(5);
			c2.send().wait(ws);
		})) {
			failed = true;
			KJ_REQUIRE(e->getType() == kj::Exception::Type::OVERLOADED, e->getType());
		}
		KJ_REQUIRE(failed, "failing tail call did not fail");
		auto ping = echo.pingRequest();
		ping.setN(20);
		KJ_REQUIRE(ping.send().wait(ws).getN() == 21);
		ok("tailcall");
	}

	if (wants(only, "cancel")) {
		{
			auto pending = echo.slowRequest().send();
			// Give the call time to arrive before dropping it.
			echo.pingRequest().send().wait(ws);
		}
		for (int i = 0; i < 50; i++) echo.pingRequest().send().wait(ws);
		auto s = echo.statsRequest().send().wait(ws);
		KJ_REQUIRE(s.getCancelled() == 1, s.getCancelled());
		ok("cancel");
	}

	if (wants(only, "embargo")) {
		unsigned seen[2] = {0, 0};
		unsigned order = 0;
		class Mine final : public Counter::Server {
		public:
			Mine(unsigned *seen, unsigned &order) : seen(seen), order(order) {}
			kj::Promise<void> inc(IncContext ctx) override {
				seen[ctx.getParams().getN() - 1] = ++order;
				ctx.getResults().setN(ctx.getParams().getN() + 1);
				return kj::READY_NOW;
			}
			unsigned *seen;
			unsigned &order;
		};
		auto hold = echo.holdRequest();
		hold.setCap(kj::heap<Mine>(seen, order));
		hold.send().wait(ws);
		auto promise = echo.promiseOfHeldRequest().send().getCap();
		auto first = promise.incRequest();
		first.setN(1);
		auto firstP = first.send();
		echo.resolveHeldRequest().send().wait(ws);
		auto second = promise.incRequest();
		second.setN(2);
		auto secondP = second.send();
		firstP.wait(ws);
		secondP.wait(ws);
		KJ_REQUIRE(seen[0] == 1 && seen[1] == 2, "calls through a resolving promise reordered");
		ok("embargo");
	}

	if (wants(only, "stream")) {
		auto open = echo.openSinkRequest();
		open.setFailAfter(0);
		auto sink = open.send().getSink();
		std::vector<unsigned char> block(4096, 7);
		const unsigned writes = 500;
		for (unsigned i = 0; i < writes; i++) {
			auto w = sink.writeRequest();
			w.setData(kj::ArrayPtr<const unsigned char>(block.data(), block.size()));
			w.send().wait(ws);
		}
		KJ_REQUIRE(sink.doneRequest().send().wait(ws).getTotal() == uint64_t(writes) * block.size());
		ok("stream");
	}

	if (wants(only, "streamfail")) {
		auto open = echo.openSinkRequest();
		open.setFailAfter(10);
		auto sink = open.send().getSink();
		std::vector<unsigned char> block(64, 1);
		bool sendFailed = false;
		KJ_IF_MAYBE(e, kj::runCatchingExceptions([&]() {
			for (unsigned i = 0; i < 100; i++) {
				auto w = sink.writeRequest();
				w.setData(kj::ArrayPtr<const unsigned char>(block.data(), block.size()));
				w.send().wait(ws);
				// Let the event loop run so the Returns can arrive.
				if (i % 10 == 9) echo.pingRequest().send().wait(ws);
			}
		})) {
			sendFailed = true;
			KJ_REQUIRE(std::string(e->getDescription().cStr()).find("sink full") != std::string::npos,
			           e->getDescription());
		}
		KJ_REQUIRE(sendFailed, "writes kept succeeding after the sink failed");
		bool doneFailed = false;
		KJ_IF_MAYBE(e, kj::runCatchingExceptions([&]() { sink.doneRequest().send().wait(ws); })) {
			doneFailed = true;
		}
		KJ_REQUIRE(doneFailed, "done() succeeded on a failed stream");
		ok("streamfail");
	}

	if (wants(only, "persistent")) {
		auto keep = echo.openKeepRequest().send().wait(ws).getKeep();
		KJ_REQUIRE(keep.valueRequest().send().wait(ws).getN() == 7);
		auto save = keep.saveRequest();
		save.setSealFor("bob");
		KJ_REQUIRE(std::string(save.send().wait(ws).getSturdyRef().cStr()) == "ref-for-bob");
		ok("persistent");
	}

	if (wants(only, "abort")) {
		echo.pingRequest().send().wait(ws);
		bool failed = false;
		// die() makes the TypeScript server abort the connection.
		KJ_IF_MAYBE(e, kj::runCatchingExceptions([&]() {
			echo.dieRequest().send().wait(ws);
			for (int i = 0; i < 100; i++) echo.pingRequest().send().wait(ws);
		})) {
			failed = true;
		}
		KJ_REQUIRE(failed, "calls kept succeeding after the peer aborted");
		ok("abort");
	}
}

} // namespace

int main(int argc, char **argv) {
	std::string mode = argc > 1 ? argv[1] : "serve";
	std::string port = argc > 2 ? argv[2] : "43118";
	if (mode == "serve") {
		capnp::EzRpcServer server(kj::heap<EchoImpl>(), "127.0.0.1:" + port);
		auto &waitScope = server.getWaitScope();
		kj::NEVER_DONE.wait(waitScope);
	}
	std::vector<std::string> only;
	for (int i = 3; i < argc; i++) only.push_back(argv[i]);
	runClient("127.0.0.1:" + port, only);
	return 0;
}
