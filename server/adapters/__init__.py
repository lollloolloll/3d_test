from .binance import BinanceAdapter
from .kidak import KidakAdapter
from .simulator import SimulatorAdapter
from .stocks import YFinanceAdapter

# config "adapter" name -> class. Register new adapters here.
REGISTRY = {
    "binance": BinanceAdapter,
    "yfinance": YFinanceAdapter,
    "kidak": KidakAdapter,
    "simulator": SimulatorAdapter,
}
