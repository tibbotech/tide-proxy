//
// Renode peripheral models for Tibbo TPP boards (G2: STM32F207, G3: STM32F439).
//
// Loaded at runtime with `include @TibboSim.cs` before the platform description.
// Everything lives in one file so the models can reference each other: Renode
// compiles each included .cs file into its own assembly.
//
//  - TibboGPIOPort   STM32 GPIO port with open-drain outputs, pulls, external
//                    (Hi-Z capable) drivers and a port-level change event.
//  - TibboSYSCFG     SYSCFG with the EXTICR port multiplexer feeding EXTI.
//  - TibboAT45       Atmel/Adesto AT45 DataFlash on SPI, file-backed.
//  - TibboAT24       AT24Cxx EEPROM on bit-banged (gpio-i2c) SCL/SDA, file-backed.
//  - TibboSDCard     SD card in SPI mode on bit-banged lines (Tibbit #49), image-file backed.
//  - TibboSSD1963    SSD1963 LCD controller on a bit-banged 8080 8-bit bus.
//  - TibboSimBridge  TCP endpoint streaming LCD/pin state and accepting inputs;
//                    makes Wiegand pulses in virtual time; persists internal flash for
//                    monitor-booted instances.
//
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

using Antmicro.Renode.Core;
using Antmicro.Renode.Logging;
using Antmicro.Renode.Peripherals.Bus;
using Antmicro.Renode.Peripherals.CPU;
using Antmicro.Renode.Peripherals.Timers;
using Antmicro.Renode.Time;

namespace Antmicro.Renode.Peripherals.GPIOPort
{
    [AllowedTranslations(AllowedTranslation.ByteToDoubleWord | AllowedTranslation.WordToDoubleWord)]
    public class TibboGPIOPort : BaseGPIOPort, IDoubleWordPeripheral, IKnownSize
    {
        // externalPullUps/externalPullDowns: board-level resistors (bit mask per pin)
        // deciding the level of a line nobody drives.
        public TibboGPIOPort(IMachine machine, uint modeResetValue = 0, uint pullResetValue = 0,
            uint speedResetValue = 0, uint externalPullUps = 0, uint externalPullDowns = 0) : base(machine, NumberOfPins)
        {
            this.modeResetValue = modeResetValue;
            this.pullResetValue = pullResetValue;
            this.speedResetValue = speedResetValue;
            this.externalPullUps = (ushort)externalPullUps;
            this.externalPullDowns = (ushort)externalPullDowns;
            Reset();
        }

        public long Size => 0x400;

        // Raised after the pin levels changed: (port, oldLevels, newLevels).
        public event Action<TibboGPIOPort, ushort, ushort> LevelsChanged;

        public ushort Levels => levels;

        public ushort OutputLatch => odr;

        public ushort OutputPins => outMask;

        // Pin configuration for the IO view: MODER, OTYPER, PUPDR, AFRL, AFRH, and which lines an
        // external device (button, wire, I2C slave, UI) drives and to what.
        public uint[] Config => new uint[] { moder, otyper, pupdr, afrl, afrh, extDriven, extLevel };

        public override void Reset()
        {
            base.Reset();
            moder = modeResetValue;
            pupdr = pullResetValue;
            ospeedr = speedResetValue;
            otyper = 0;
            odr = 0;
            lckr = 0;
            afrl = 0;
            afrh = 0;
            // extDriven/extLevel are kept: external circuits keep driving through an MCU reset.
            levels = 0;
            UpdateMasks();
            Update();
        }

        public uint ReadDoubleWord(long offset)
        {
            switch(offset)
            {
            case 0x00: return moder;
            case 0x04: return otyper;
            case 0x08: return ospeedr;
            case 0x0C: return pupdr;
            case 0x10: return levels;
            case 0x14: return odr;
            case 0x18: return 0;
            case 0x1C: return lckr;
            case 0x20: return afrl;
            case 0x24: return afrh;
            default:
                this.LogUnhandledRead(offset);
                return 0;
            }
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            switch(offset)
            {
            case 0x00: moder = value; UpdateMasks(); break;
            case 0x04: otyper = value & 0xFFFF; UpdateMasks(); break;
            case 0x08: ospeedr = value; return;
            case 0x0C: pupdr = value; UpdateMasks(); break;
            case 0x10: return;
            case 0x14: odr = (ushort)value; break;
            case 0x18:
                // Reset first so that set wins when both bits are written.
                odr = (ushort)((odr & ~(value >> 16)) | (value & 0xFFFF));
                break;
            case 0x1C: lckr = value; return;
            case 0x20: afrl = value; return;
            case 0x24: afrh = value; return;
            case 0x28: odr = (ushort)(odr & ~value); break;
            default:
                this.LogUnhandledWrite(offset, value);
                return;
            }
            Update();
        }

        // Standard Renode GPIO input (e.g. Miscellaneous.Button): drive the line.
        public override void OnGPIO(int number, bool value)
        {
            if(!CheckPinNumber(number))
            {
                return;
            }
            Drive(number, value);
        }

        // External device drives the line (wins over pulls, loses to push-pull outputs).
        public void Drive(int pin, bool level)
        {
            DriveMask((ushort)(1 << pin), level ? (ushort)(1 << pin) : (ushort)0);
        }

        // External device stops driving the line (Hi-Z).
        public void Release(int pin)
        {
            ReleaseMask((ushort)(1 << pin));
        }

        public void DriveMask(ushort mask, ushort value)
        {
            extDriven |= mask;
            extLevel = (ushort)((extLevel & ~mask) | (value & mask));
            Update();
        }

        public void ReleaseMask(ushort mask)
        {
            extDriven = (ushort)(extDriven & ~mask);
            Update();
        }

        public bool GetLevel(int pin)
        {
            return (levels & (1 << pin)) != 0;
        }

        // A pull-up resistor that comes with a plugged-in device (an SD card's on MISO).
        public void SetExternalPullUp(int pin, bool on)
        {
            var bit = (ushort)(1 << pin);
            externalPullUps = on ? (ushort)(externalPullUps | bit) : (ushort)(externalPullUps & ~bit);
            UpdateMasks();
            Update();
        }

        private void UpdateMasks()
        {
            ushort outM = 0, afM = 0, inM = 0, pu = 0, pd = 0;
            for(var i = 0; i < NumberOfPins; i++)
            {
                var m = (moder >> (2 * i)) & 3;
                var bit = (ushort)(1 << i);
                switch(m)
                {
                case 0: inM |= bit; break;
                case 1: outM |= bit; break;
                case 2: afM |= bit; break;
                }
                var p = (pupdr >> (2 * i)) & 3;
                if(p == 1)
                {
                    pu |= bit;
                }
                else if(p == 2)
                {
                    pd |= bit;
                }
            }
            outMask = outM;
            inputMask = (ushort)(inM | afM);
            openDrainMask = (ushort)(outM & otyper);
            // Internal pulls win over board resistors only where they pull the other way.
            floatHigh = (ushort)((pu | externalPullUps) & ~pd & ~(externalPullDowns & ~pu));
        }

        private void Update()
        {
            var lineIfReleased = (ushort)((extDriven & extLevel) | (~extDriven & floatHigh));
            var pushPull = (ushort)(outMask & ~openDrainMask);
            var newLevels = (ushort)((pushPull & odr)
                | (openDrainMask & odr & lineIfReleased)
                | (inputMask & lineIfReleased));
            var old = levels;
            if(newLevels == old)
            {
                return;
            }
            levels = newLevels;
            var changed = (ushort)(old ^ newLevels);
            for(var i = 0; i < NumberOfPins; i++)
            {
                if((changed & (1 << i)) != 0)
                {
                    var v = (newLevels & (1 << i)) != 0;
                    State[i] = v;
                    Connections[i].Set(v);
                }
            }
            LevelsChanged?.Invoke(this, old, newLevels);
        }

        private uint moder, otyper, ospeedr, pupdr, lckr, afrl, afrh;
        private ushort odr;
        private ushort extDriven, extLevel;
        private ushort levels;
        private ushort outMask, inputMask, openDrainMask, floatHigh;

        private readonly uint modeResetValue, pullResetValue, speedResetValue;
        private readonly ushort externalPullDowns;
        private ushort externalPullUps;

        private const int NumberOfPins = 16;
    }
}

namespace Antmicro.Renode.Peripherals.Miscellaneous
{
    using Antmicro.Renode.Peripherals.GPIOPort;

    // SYSCFG: GPIO inputs are numbered port*16+pin; outputs 0-15 go to EXTI lines.
    public class TibboSYSCFG : IDoubleWordPeripheral, IKnownSize, IGPIOReceiver, INumberedGPIOOutput
    {
        public TibboSYSCFG(int numberOfPorts = 11)
        {
            this.numberOfPorts = numberOfPorts;
            inputs = new bool[numberOfPorts * 16];
            var connections = new Dictionary<int, IGPIO>();
            for(var i = 0; i < 16; i++)
            {
                connections[i] = new GPIO();
            }
            Connections = connections;
            Reset();
        }

        public IReadOnlyDictionary<int, IGPIO> Connections { get; }

        public long Size => 0x400;

        public void Reset()
        {
            memrmp = 0;
            pmc = 0;
            cmpcr = 0;
            Array.Clear(exticr, 0, exticr.Length);
            for(var line = 0; line < 16; line++)
            {
                RefreshLine(line);
            }
        }

        public void OnGPIO(int number, bool value)
        {
            if(number < 0 || number >= inputs.Length)
            {
                return;
            }
            inputs[number] = value;
            var line = number % 16;
            if(SelectedPort(line) == number / 16)
            {
                Connections[line].Set(value);
            }
        }

        public uint ReadDoubleWord(long offset)
        {
            switch(offset)
            {
            case 0x00: return memrmp;
            case 0x04: return pmc;
            case 0x08: case 0x0C: case 0x10: case 0x14: return exticr[(offset - 0x08) / 4];
            case 0x20: return cmpcr | ((cmpcr & 1) != 0 ? 0x100u : 0u);
            default: return 0;
            }
        }

        public void WriteDoubleWord(long offset, uint value)
        {
            switch(offset)
            {
            case 0x00: memrmp = value; break;
            case 0x04: pmc = value; break;
            case 0x08: case 0x0C: case 0x10: case 0x14:
                var idx = (int)(offset - 0x08) / 4;
                exticr[idx] = value & 0xFFFF;
                for(var i = 0; i < 4; i++)
                {
                    RefreshLine(idx * 4 + i);
                }
                break;
            case 0x20: cmpcr = value & 1; break;
            }
        }

        private int SelectedPort(int line)
        {
            return (int)((exticr[line / 4] >> (4 * (line % 4))) & 0xF);
        }

        private void RefreshLine(int line)
        {
            var port = SelectedPort(line);
            var v = port < numberOfPorts && inputs[port * 16 + line];
            Connections[line].Set(v);
        }

        private uint memrmp, pmc, cmpcr;
        private readonly uint[] exticr = new uint[4];
        private readonly bool[] inputs;
        private readonly int numberOfPorts;
    }

    // AT24Cxx EEPROM behind a bit-banged I2C bus (Zephyr "gpio-i2c").
    public class TibboAT24 : IDoubleWordPeripheral, IKnownSize
    {
        public TibboAT24(TibboGPIOPort sclPort, int sclPin, TibboGPIOPort sdaPort, int sdaPin,
            int size = 2048, int pageSize = 16, int address = 0x50)
        {
            this.sclPort = sclPort;
            this.sclPin = sclPin;
            this.sdaPort = sdaPort;
            this.sdaPin = sdaPin;
            this.pageSize = pageSize;
            this.address = address;
            memory = new byte[size];
            for(var i = 0; i < size; i++)
            {
                memory[i] = 0xFF;
            }
            sclPort.LevelsChanged += OnLevels;
            if(sdaPort != sclPort)
            {
                sdaPort.LevelsChanged += OnLevels;
            }
            Reset();
        }

        // Monitor handle only: the device sits on a small dummy bus window.
        public long Size => 0x100;

        public uint ReadDoubleWord(long offset)
        {
            return 0;
        }

        public void WriteDoubleWord(long offset, uint value)
        {
        }

        public void Reset()
        {
            state = State.Idle;
            bitCount = 0;
            ackSlot = false;
            lastScl = true;
            lastSda = true;
            sdaPort.Release(sdaPin);
        }

        // Backing file; created (blank, 0xFF) if it does not exist.
        public string BackingFile
        {
            get => backingFile;
            set
            {
                backingFile = value;
                if(File.Exists(value))
                {
                    var data = File.ReadAllBytes(value);
                    Array.Copy(data, memory, Math.Min(data.Length, memory.Length));
                }
                else
                {
                    Persist();
                }
            }
        }

        // Writes a TiOS MAC record (length 6, MAC, ~checksum) at offset 0 unless a valid one exists.
        public void InitMac(string mac)
        {
            if(MacRecordValid())
            {
                this.Log(LogLevel.Info, "EEPROM already holds MAC {0}", Mac);
                return;
            }
            SetMac(mac);
        }

        public void SetMac(string mac)
        {
            var parts = mac.Split(':', '-', '.');
            if(parts.Length != 6)
            {
                throw new ArgumentException("MAC must have 6 octets");
            }
            byte sum = 6;
            memory[0] = 6;
            for(var i = 0; i < 6; i++)
            {
                var b = parts[i].Length > 2 || mac.Contains(".") ? byte.Parse(parts[i]) : Convert.ToByte(parts[i], 16);
                memory[1 + i] = b;
                sum += b;
            }
            memory[7] = (byte)~sum;
            Persist();
            this.Log(LogLevel.Info, "EEPROM MAC set to {0}", Mac);
        }

        public string Mac => string.Format("{0:x2}:{1:x2}:{2:x2}:{3:x2}:{4:x2}:{5:x2}",
            memory[1], memory[2], memory[3], memory[4], memory[5], memory[6]);

        public byte ReadByte(int offset)
        {
            return memory[offset % memory.Length];
        }

        public void WriteByte(int offset, byte value)
        {
            memory[offset % memory.Length] = value;
            Persist();
        }

        private bool MacRecordValid()
        {
            byte sum = memory[0];
            for(var i = 1; i <= 6; i++)
            {
                sum += memory[i];
            }
            return memory[0] == 6 && sum == (byte)~memory[7];
        }

        private void OnLevels(TibboGPIOPort port, ushort oldLevels, ushort newLevels)
        {
            var scl = sclPort.GetLevel(sclPin);
            var sda = sdaPort.GetLevel(sdaPin);
            var prevScl = lastScl;
            var prevSda = lastSda;
            if(scl == prevScl && sda == prevSda)
            {
                return;
            }
            lastScl = scl;
            lastSda = sda;

            if(scl && prevScl)
            {
                // SDA moved while SCL high: START or STOP.
                if(!sda)
                {
                    Start();
                }
                else
                {
                    Stop();
                }
                return;
            }
            if(scl && !prevScl)
            {
                Rising(sda);
            }
            else if(!scl && prevScl)
            {
                Falling();
            }
        }

        private void Start()
        {
            if(dirty)
            {
                Persist();
            }
            sdaPort.Release(sdaPin);
            state = State.Address;
            bitCount = 0;
            shift = 0;
            ackSlot = false;
        }

        private void Stop()
        {
            sdaPort.Release(sdaPin);
            state = State.Idle;
            ackSlot = false;
            if(dirty)
            {
                Persist();
            }
        }

        private void Rising(bool sda)
        {
            switch(state)
            {
            case State.Address:
            case State.WordAddress:
            case State.Data:
                if(!ackSlot && bitCount < 8)
                {
                    shift = (shift << 1) | (sda ? 1 : 0);
                    bitCount++;
                }
                break;
            case State.Transmit:
                if(ackSlot)
                {
                    masterAck = !sda;
                }
                break;
            }
        }

        private void Falling()
        {
            switch(state)
            {
            case State.Address:
            case State.WordAddress:
            case State.Data:
                if(ackSlot)
                {
                    // End of our ACK clock.
                    ackSlot = false;
                    sdaPort.Release(sdaPin);
                    bitCount = 0;
                    shift = 0;
                }
                else if(bitCount == 8)
                {
                    if(HandleByte((byte)shift))
                    {
                        sdaPort.Drive(sdaPin, false);
                        ackSlot = true;
                    }
                    else
                    {
                        state = State.Idle;
                    }
                }
                break;
            case State.Transmit:
                if(ackSlot)
                {
                    ackSlot = false;
                    if(masterAck)
                    {
                        pointer = (pointer + 1) % memory.Length;
                        txByte = memory[pointer];
                        txBits = 0;
                        DriveNextBit();
                    }
                    else
                    {
                        state = State.Idle;
                        sdaPort.Release(sdaPin);
                    }
                }
                else if(txBits < 8)
                {
                    DriveNextBit();
                }
                else
                {
                    // Release the line for the master's ACK/NACK.
                    sdaPort.Release(sdaPin);
                    ackSlot = true;
                }
                break;
            case State.AddressAckThenTransmit:
                // End of our address ACK: start sending the first byte.
                ackSlot = false;
                state = State.Transmit;
                txByte = memory[pointer];
                txBits = 0;
                DriveNextBit();
                break;
            }
        }

        private void DriveNextBit()
        {
            var bit = (txByte >> (7 - txBits)) & 1;
            txBits++;
            if(bit != 0)
            {
                sdaPort.Release(sdaPin);
            }
            else
            {
                sdaPort.Drive(sdaPin, false);
            }
        }

        private bool HandleByte(byte b)
        {
            switch(state)
            {
            case State.Address:
                var dev = b >> 1;
                var blocks = Math.Max(1, memory.Length / 256);
                if(dev < address || dev >= address + Math.Min(8, blocks))
                {
                    return false;
                }
                block = dev - address;
                if((b & 1) != 0)
                {
                    // Read: ACK, then transmit from the current pointer once the ACK clock ends.
                    state = State.AddressAckThenTransmit;
                    return true;
                }
                state = State.WordAddress;
                return true;
            case State.WordAddress:
                pointer = ((block << 8) | b) % memory.Length;
                state = State.Data;
                return true;
            case State.Data:
                memory[pointer] = b;
                dirty = true;
                var pageStart = pointer - (pointer % pageSize);
                pointer = pageStart + ((pointer + 1 - pageStart) % pageSize);
                return true;
            }
            return false;
        }

        private void Persist()
        {
            dirty = false;
            if(backingFile == null)
            {
                return;
            }
            try
            {
                File.WriteAllBytes(backingFile, memory);
            }
            catch(Exception e)
            {
                this.Log(LogLevel.Warning, "Cannot write {0}: {1}", backingFile, e.Message);
            }
        }

        private enum State
        {
            Idle,
            Address,
            AddressAckThenTransmit,
            WordAddress,
            Data,
            Transmit,
        }

        private State state;
        private int bitCount, shift, block, pointer, txBits;
        private byte txByte;
        private bool ackSlot, masterAck, lastScl, lastSda, dirty;
        private string backingFile;

        private readonly byte[] memory;
        private readonly int pageSize, address;
        private readonly TibboGPIOPort sclPort, sdaPort;
        private readonly int sclPin, sdaPin;
    }

    // SD card (SDHC, SPI mode) on bit-banged lines: Tibbit #49 driven by Cody's tibbo,spi-bitbang-stm32
    // driver under Zephyr's sdhc-spi. Backed by an image file (ImageFile), whose size in whole 512 KiB
    // units is the card's capacity.
    // SPI mode 0, MSB first: MOSI is sampled on the rising edge of CLK, MISO changes on the falling edge
    // and shows a byte's first bit as soon as CS goes low. The host drops CS between transactions (even
    // between single-byte polls), so the card keeps its state and the bytes it has yet to send across CS
    // cycles. A response follows its command after one byte (NCR = 1), a data block its response after
    // one more (NAC = 1), and the card is never busy. Command CRCs are not checked; data blocks carry a
    // valid CRC16, which the host checks.
    public class TibboSDCard : IDoubleWordPeripheral, IKnownSize, IDisposable
    {
        public TibboSDCard(TibboGPIOPort clkPort, int clkPin, TibboGPIOPort mosiPort, int mosiPin,
            TibboGPIOPort misoPort, int misoPin, TibboGPIOPort csPort, int csPin)
        {
            this.clkPort = clkPort;
            this.clkPin = clkPin;
            this.mosiPort = mosiPort;
            this.mosiPin = mosiPin;
            this.misoPort = misoPort;
            this.misoPin = misoPin;
            this.csPort = csPort;
            this.csPin = csPin;
            // The slot pulls MISO up: an idle (or missing) card reads as 0xFF.
            misoPort.SetExternalPullUp(misoPin, true);
            clkPort.LevelsChanged += OnLevels;
            if(csPort != clkPort)
            {
                csPort.LevelsChanged += OnLevels;
            }
            Reset();
        }

        // Monitor handle only: the device sits on a small dummy bus window.
        public long Size => 0x100;

        public uint ReadDoubleWord(long offset)
        {
            return 0;
        }

        public void WriteDoubleWord(long offset, uint value)
        {
        }

        public void Reset()
        {
            output.Clear();
            state = State.Command;
            cmdLength = 0;
            idle = true;
            appCmd = false;
            streaming = false;
            bitCount = 0;
            lastClk = clkPort.GetLevel(clkPin);
            selected = false;
            misoPort.Release(misoPin);
            OnLevels(clkPort, 0, 0);
        }

        // The card image; opened for reading and writing, not loaded into memory.
        public string ImageFile
        {
            get => imageFile;
            set
            {
                image?.Dispose();
                image = null;
                blockCount = 0;
                imageFile = value;
                var stream = new FileStream(value, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite);
                var count = stream.Length / CapacityUnit * (CapacityUnit / BlockSize);
                if(count == 0)
                {
                    stream.Dispose();
                    throw new ArgumentException($"{value} is smaller than 512 KiB");
                }
                image = stream;
                blockCount = count;
                this.Log(LogLevel.Info, "card image {0}, {1} MiB", value, blockCount / 2048);
                Reset();
            }
        }

        // A removed card never answers (MISO stays pulled up). Putting it back starts it over at power-up.
        public bool Inserted
        {
            get => inserted;
            set
            {
                if(inserted == value)
                {
                    return;
                }
                inserted = value;
                this.Log(LogLevel.Info, value ? "card inserted" : "card removed");
                Reset();
            }
        }

        public long BlockCount => blockCount;

        public long BlocksRead => blocksRead;

        public long BlocksWritten => blocksWritten;

        public void Dispose()
        {
            image?.Dispose();
            image = null;
        }

        private void OnLevels(TibboGPIOPort port, ushort oldLevels, ushort newLevels)
        {
            var select = inserted && image != null && !csPort.GetLevel(csPin);
            if(select != selected)
            {
                selected = select;
                bitCount = 0;
                if(selected)
                {
                    DriveBit(Peek() >> 7);
                }
                else
                {
                    misoPort.Release(misoPin);
                }
            }
            var clk = clkPort.GetLevel(clkPin);
            if(clk == lastClk)
            {
                return;
            }
            lastClk = clk;
            if(!selected)
            {
                return;
            }
            if(clk)
            {
                Rising();
            }
            else
            {
                Falling();
            }
        }

        private void Rising()
        {
            if(bitCount == 0)
            {
                // The byte whose first bit MISO shows is now being clocked out.
                txByte = Peek();
                if(output.Count > 0)
                {
                    output.Dequeue();
                }
                rxByte = 0;
            }
            rxByte = (byte)((rxByte << 1) | (mosiPort.GetLevel(mosiPin) ? 1 : 0));
            bitCount++;
            if(bitCount == 8)
            {
                Receive(rxByte);
            }
        }

        private void Falling()
        {
            if(bitCount == 8)
            {
                bitCount = 0;
                DriveBit(Peek() >> 7);
            }
            else if(bitCount > 0)
            {
                DriveBit(txByte >> (7 - bitCount));
            }
        }

        private void DriveBit(int bit)
        {
            misoPort.Drive(misoPin, (bit & 1) != 0);
        }

        // The next byte to send: queued output, the next block of a multiple-block read, else 0xFF.
        private byte Peek()
        {
            if(output.Count == 0 && streaming)
            {
                if(streamBlock < blockCount)
                {
                    QueueBlock(ReadBlock(streamBlock++));
                }
                else
                {
                    streaming = false;
                }
            }
            return output.Count > 0 ? output.Peek() : (byte)0xFF;
        }

        private void Receive(byte b)
        {
            switch(state)
            {
            case State.Command:
                // A command starts with bits 01; anything else between commands is filler.
                if(cmdLength == 0 && (b & 0xC0) != 0x40)
                {
                    return;
                }
                command[cmdLength++] = b;
                if(cmdLength == 6)
                {
                    cmdLength = 0;
                    Execute(command[0] & 0x3F, (uint)((command[1] << 24) | (command[2] << 16) | (command[3] << 8) | command[4]));
                }
                return;
            case State.WriteToken:
                if(b == TokenSingle || b == TokenMultiWrite)
                {
                    state = State.WriteData;
                    dataLength = 0;
                }
                else if(b == TokenStopTran && multiWrite)
                {
                    state = State.Command;
                }
                else if((b & 0xC0) == 0x40)
                {
                    state = State.Command;
                    command[0] = b;
                    cmdLength = 1;
                }
                return;
            case State.WriteData:
                // The block, then its CRC16 (not checked).
                writeBuffer[dataLength++] = b;
                if(dataLength == BlockSize + 2)
                {
                    WriteBlock();
                }
                return;
            }
        }

        private void Execute(int index, uint arg)
        {
            var app = appCmd;
            appCmd = false;
            // A new command ends whatever the card was sending.
            output.Clear();
            streaming = false;
            state = State.Command;
            this.Log(LogLevel.Debug, "{0}CMD{1} 0x{2:X8}", app ? "A" : "", index, arg);
            output.Enqueue(0xFF);
            if(app && ExecuteApp(index, arg))
            {
                return;
            }
            switch(index)
            {
            case 0: // GO_IDLE_STATE
                idle = true;
                output.Enqueue(R1Idle);
                break;
            case 8: // SEND_IF_COND: R7 echoes the voltage and check pattern
                Respond(R1());
                output.Enqueue(0);
                output.Enqueue(0);
                output.Enqueue((byte)((arg >> 8) & 0x0F));
                output.Enqueue((byte)arg);
                break;
            case 9: // SEND_CSD
                Respond(R1());
                QueueBlock(Csd());
                break;
            case 10: // SEND_CID
                Respond(R1());
                QueueBlock(Cid);
                break;
            case 12: // STOP_TRANSMISSION (R1b, never busy)
                Respond(R1());
                break;
            case 13: // SEND_STATUS: R2
                Respond(R1());
                output.Enqueue(0);
                break;
            case 17: // READ_SINGLE_BLOCK
            case 18: // READ_MULTIPLE_BLOCK
                if(arg >= blockCount)
                {
                    Respond(R1ParameterError);
                    break;
                }
                Respond(R1());
                if(index == 17)
                {
                    QueueBlock(ReadBlock(arg));
                }
                else
                {
                    streaming = true;
                    streamBlock = arg;
                }
                break;
            case 24: // WRITE_BLOCK
            case 25: // WRITE_MULTIPLE_BLOCK
                if(arg >= blockCount)
                {
                    Respond(R1ParameterError);
                    break;
                }
                Respond(R1());
                state = State.WriteToken;
                multiWrite = index == 25;
                writeAddress = arg;
                lastWritten = 0;
                break;
            case 55: // APP_CMD
                appCmd = true;
                Respond(R1());
                break;
            case 58: // READ_OCR: R3, 3.2-3.4 V; power-up done and SDHC once initialised
                Respond(R1());
                output.Enqueue((byte)(idle ? 0x00 : 0xC0));
                output.Enqueue(0xFF);
                output.Enqueue(0x80);
                output.Enqueue(0x00);
                break;
            case 6: // SWITCH_FUNC: no switchable functions
                Respond(R1());
                QueueBlock(new byte[64]);
                break;
            case 16: // SET_BLOCKLEN (fixed at 512 on SDHC)
            case 32: // ERASE_WR_BLK_START
            case 33: // ERASE_WR_BLK_END
            case 38: // ERASE (nothing is cleared)
            case 59: // CRC_ON_OFF
                Respond(R1());
                break;
            default:
                Respond((byte)(R1() | R1IllegalCommand));
                break;
            }
        }

        // Application commands (after CMD55). False: not one, run it as a plain command.
        private bool ExecuteApp(int index, uint arg)
        {
            switch(index)
            {
            case 41: // SD_SEND_OP_COND: initialisation completes at once
                if(idle)
                {
                    this.Log(LogLevel.Info, "card initialised by the host");
                }
                idle = false;
                Respond(R1());
                return true;
            case 13: // SD_STATUS: R2 and a 64-byte status block
                Respond(R1());
                output.Enqueue(0);
                QueueBlock(new byte[64]);
                return true;
            case 22: // SEND_NUM_WR_BLOCKS
                Respond(R1());
                QueueBlock(new[] { (byte)(lastWritten >> 24), (byte)(lastWritten >> 16), (byte)(lastWritten >> 8), (byte)lastWritten });
                return true;
            case 23: // SET_WR_BLK_ERASE_COUNT
            case 42: // SET_CLR_CARD_DETECT
                Respond(R1());
                return true;
            case 51: // SEND_SCR: SD 3.0, 1- and 4-bit bus, no CMD23
                Respond(R1());
                QueueBlock(new byte[] { 0x02, 0x05, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00 });
                return true;
            }
            return false;
        }

        private byte R1()
        {
            return idle ? R1Idle : (byte)0;
        }

        private void Respond(byte r1)
        {
            output.Enqueue(r1);
        }

        // NAC, start token, data, CRC16.
        private void QueueBlock(byte[] data)
        {
            output.Enqueue(0xFF);
            output.Enqueue(TokenSingle);
            foreach(var b in data)
            {
                output.Enqueue(b);
            }
            var crc = Crc16(data);
            output.Enqueue((byte)(crc >> 8));
            output.Enqueue((byte)crc);
        }

        private byte[] ReadBlock(long block)
        {
            var data = new byte[BlockSize];
            try
            {
                image.Seek(block * BlockSize, SeekOrigin.Begin);
                var done = 0;
                while(done < BlockSize)
                {
                    var n = image.Read(data, done, BlockSize - done);
                    if(n <= 0)
                    {
                        break;
                    }
                    done += n;
                }
            }
            catch(Exception e)
            {
                this.Log(LogLevel.Warning, "cannot read block {0}: {1}", block, e.Message);
            }
            blocksRead++;
            this.Log(LogLevel.Noisy, "read block {0}", block);
            return data;
        }

        private void WriteBlock()
        {
            byte token = DataAccepted;
            if(writeAddress >= blockCount)
            {
                token = DataWriteError;
            }
            else
            {
                try
                {
                    image.Seek(writeAddress * BlockSize, SeekOrigin.Begin);
                    image.Write(writeBuffer, 0, BlockSize);
                    image.Flush();
                    blocksWritten++;
                    lastWritten++;
                    this.Log(LogLevel.Noisy, "wrote block {0}", writeAddress);
                }
                catch(Exception e)
                {
                    this.Log(LogLevel.Warning, "cannot write block {0}: {1}", writeAddress, e.Message);
                    token = DataWriteError;
                }
                writeAddress++;
            }
            output.Enqueue(token);
            state = multiWrite && token == DataAccepted ? State.WriteToken : State.Command;
        }

        // CSD version 2.0 (SDHC): 512-byte blocks, capacity (C_SIZE + 1) * 512 KiB.
        private byte[] Csd()
        {
            var cSize = blockCount / (CapacityUnit / BlockSize) - 1;
            var csd = new byte[] {
                0x40, 0x0E, 0x00, 0x32, 0x5B, 0x59, 0x00,
                (byte)((cSize >> 16) & 0x3F), (byte)(cSize >> 8), (byte)cSize,
                0x7F, 0x80, 0x0A, 0x40, 0x00, 0x00,
            };
            csd[15] = (byte)((Crc7(csd, 15) << 1) | 1);
            return csd;
        }

        private static readonly byte[] Cid = MakeCid();

        // Manufacturer 0x54, OEM "TB", product "SIMSD", revision 1.0, made 2026-01.
        private static byte[] MakeCid()
        {
            var cid = new byte[] { 0x54, (byte)'T', (byte)'B', (byte)'S', (byte)'I', (byte)'M', (byte)'S', (byte)'D', 0x10, 0x00, 0x00, 0x00, 0x01, 0x01, 0xA1, 0x00 };
            cid[15] = (byte)((Crc7(cid, 15) << 1) | 1);
            return cid;
        }

        private static byte Crc7(byte[] data, int length)
        {
            var crc = 0;
            for(var i = 0; i < length; i++)
            {
                for(var bit = 7; bit >= 0; bit--)
                {
                    var top = (crc >> 6) & 1;
                    crc = (crc << 1) & 0x7F;
                    if((((data[i] >> bit) & 1) ^ top) != 0)
                    {
                        crc ^= 0x09;
                    }
                }
            }
            return (byte)crc;
        }

        // CRC16-CCITT (XMODEM), as Zephyr's crc16_itu_t(0, ...).
        private static ushort Crc16(byte[] data)
        {
            var crc = 0;
            foreach(var b in data)
            {
                crc ^= b << 8;
                for(var i = 0; i < 8; i++)
                {
                    crc = (crc & 0x8000) != 0 ? (crc << 1) ^ 0x1021 : crc << 1;
                }
            }
            return (ushort)crc;
        }

        private enum State
        {
            Command,
            WriteToken,
            WriteData,
        }

        private const int BlockSize = 512;
        private const long CapacityUnit = 512 * 1024;
        private const byte R1Idle = 0x01;
        private const byte R1IllegalCommand = 0x04;
        private const byte R1ParameterError = 0x40;
        private const byte TokenSingle = 0xFE;
        private const byte TokenMultiWrite = 0xFC;
        private const byte TokenStopTran = 0xFD;
        private const byte DataAccepted = 0xE5;
        private const byte DataWriteError = 0xED;

        private readonly Queue<byte> output = new Queue<byte>();
        private readonly byte[] command = new byte[6];
        private readonly byte[] writeBuffer = new byte[BlockSize + 2];
        private State state;
        private int cmdLength, dataLength, bitCount;
        private byte txByte, rxByte;
        private bool selected, lastClk, idle, appCmd, streaming, multiWrite;
        private bool inserted = true;
        private long streamBlock, writeAddress, blockCount, blocksRead, blocksWritten;
        private uint lastWritten;
        private FileStream image;
        private string imageFile;

        private readonly TibboGPIOPort clkPort, mosiPort, misoPort, csPort;
        private readonly int clkPin, mosiPin, misoPin, csPin;
    }

    // TCP endpoint for the sim-manager. Outbound frames: [type:u8][length:u32 LE][payload]
    //   type 1: JSON state, type 2: LCD rectangle (x,y,w,h as u16 LE, then RGB888 rows),
    //   type 3: JSON pin configuration (sent when it changes; it rarely does, unlike the levels).
    // Inbound: text lines "drive <port> <pin> <0|1>", "release <port> <pin>", "full",
    //   "reset", "pause", "resume", and
    //   "wiegand <pulseUs> <gapUs> <D0 pins|-> <D1 pins|-> <bits>": a card swipe. Pins are port letter
    //   and number (D5), comma separated. Each bit pulls its line low for pulseUs, then high for gapUs.
    public class TibboSimBridge : IDoubleWordPeripheral, IKnownSize, IDisposable
    {
        public TibboSimBridge(IMachine machine, Video.TibboSSD1963 lcd,
            TibboGPIOPort portA, TibboGPIOPort portB, TibboGPIOPort portC, TibboGPIOPort portD, TibboGPIOPort portE,
            TibboGPIOPort portF, TibboGPIOPort portG, TibboGPIOPort portH, TibboGPIOPort portI,
            int blueBarResetPin = 10, int blueBarClockPin = 11, int blueBarDataPin = 12)
        {
            this.machine = machine;
            this.lcd = lcd;
            ports = new[] { portA, portB, portC, portD, portE, portF, portG, portH, portI };
            this.blueBarResetPin = blueBarResetPin;
            this.blueBarClockPin = blueBarClockPin;
            this.blueBarDataPin = blueBarDataPin;
            portA.LevelsChanged += OnPortA;
            foreach(var p in ports)
            {
                p.LevelsChanged += (port, o, n) => pinsDirty = true;
            }
        }

        // Monitor handle only: the device sits on a small dummy bus window.
        public long Size => 0x100;

        public uint ReadDoubleWord(long offset)
        {
            return 0;
        }

        public void WriteDoubleWord(long offset, uint value)
        {
        }

        public void Reset()
        {
            blueBar = 0;
            pinsDirty = true;
            // The monitor reboots after installing an upload; keep what it wrote.
            SaveFlash();
        }

        // Internal flash image of an instance booted through the Tibbo monitor (loaded by the resc
        // with LoadBinary). Written back on every reset and by SaveFlash before quitting.
        public string FlashFile { get; set; }

        public int FlashSize { get; set; }

        public void SaveFlash()
        {
            if(FlashFile == null || FlashSize <= 0)
            {
                return;
            }
            try
            {
                var data = machine.SystemBus.ReadBytes(0x08000000UL, FlashSize);
                var tmp = FlashFile + ".tmp";
                File.WriteAllBytes(tmp, data);
                File.Move(tmp, FlashFile, true);
            }
            catch(Exception e)
            {
                this.Log(LogLevel.Warning, "Saving flash to {0} failed: {1}", FlashFile, e.Message);
            }
        }

        // Instances booted through the Tibbo monitor: its Loader never sleeps, it polls the RX
        // descriptors and the PHY (over MDIO) in a loop. Each MDIO access is a call into the MAC model
        // that takes host time but almost no virtual time, so at full speed the Loader runs many times
        // slower than real time. Every 10 ms of virtual time the CPU is set to monitorMips while it
        // executes the monitor (flash below monitorEnd) and to appMips while it executes the app.
        public void ThrottleMonitor(ulong monitorEnd, uint monitorMips, uint appMips)
        {
            var cpu = machine.SystemBus.GetCPUs().OfType<BaseCPU>().FirstOrDefault();
            if(cpu == null)
            {
                throw new InvalidOperationException("No CPU to throttle");
            }
            if(throttleTimer != null)
            {
                throttleTimer.Enabled = false;
            }
            throttleTimer = new LimitTimer(machine.ClockSource, 1000, this, "monitorThrottle", 10, enabled: true, eventEnabled: true);
            throttleTimer.LimitReached += () =>
            {
                var pc = (ulong)cpu.PC;
                if(pc >= 0x08000000UL && pc < 0x08000000UL + (ulong)FlashSize)
                {
                    cpu.PerformanceInMips = pc < monitorEnd ? monitorMips : appMips;
                }
            };
        }

        // Setting the port starts listening (0.0.0.0:<port>).
        public int Port
        {
            get => listenPort;
            set
            {
                if(listener != null)
                {
                    throw new InvalidOperationException("Bridge already listening");
                }
                listenPort = value;
                listener = new TcpListener(IPAddress.Any, value);
                listener.Start();
                running = true;
                new Thread(AcceptLoop) { IsBackground = true, Name = "TibboSimBridge" }.Start();
                this.Log(LogLevel.Info, "Sim bridge listening on {0}", value);
            }
        }

        public int BlueBar => blueBar;

        public void Dispose()
        {
            running = false;
            if(throttleTimer != null)
            {
                throttleTimer.Enabled = false;
            }
            try
            {
                listener?.Stop();
            }
            catch(Exception)
            {
            }
        }

        private void OnPortA(TibboGPIOPort port, ushort o, ushort n)
        {
            // 5-bit shift register: data active low, shifted on clock rising edge, reset active low.
            var rstNow = (n & (1 << blueBarResetPin)) != 0;
            var rstWas = (o & (1 << blueBarResetPin)) != 0;
            if(!rstNow && rstWas)
            {
                blueBar = 0;
                pinsDirty = true;
            }
            var clkNow = (n & (1 << blueBarClockPin)) != 0;
            var clkWas = (o & (1 << blueBarClockPin)) != 0;
            if(clkNow && !clkWas && rstNow)
            {
                var ledOn = (n & (1 << blueBarDataPin)) == 0;
                blueBar = ((blueBar << 1) | (ledOn ? 1 : 0)) & 0x1F;
                pinsDirty = true;
            }
        }

        private void AcceptLoop()
        {
            while(running)
            {
                TcpClient client;
                try
                {
                    client = listener.AcceptTcpClient();
                }
                catch(Exception)
                {
                    return;
                }
                client.NoDelay = true;
                new Thread(() => ServeClient(client)) { IsBackground = true, Name = "TibboSimBridgeClient" }.Start();
            }
        }

        private void ServeClient(TcpClient client)
        {
            var stream = client.GetStream();
            var alive = true;
            var reader = new Thread(() =>
            {
                try
                {
                    var sr = new StreamReader(stream, Encoding.ASCII);
                    string line;
                    while((line = sr.ReadLine()) != null)
                    {
                        HandleCommand(line.Trim());
                    }
                }
                catch(Exception)
                {
                }
                alive = false;
            }) { IsBackground = true };
            reader.Start();

            var full = true;
            string lastJson = null;
            string lastPinConfig = null;
            try
            {
                while(running && alive)
                {
                    if(Interlocked.Exchange(ref fullRequested, 0) != 0)
                    {
                        full = true;
                    }
                    var pinConfig = PinConfigJson();
                    if(pinConfig != lastPinConfig)
                    {
                        WriteFrame(stream, 3, Encoding.UTF8.GetBytes(pinConfig));
                        lastPinConfig = pinConfig;
                    }
                    var json = StateJson();
                    if(json != lastJson)
                    {
                        WriteFrame(stream, 1, Encoding.UTF8.GetBytes(json));
                        lastJson = json;
                    }
                    if(lcd.TakeDirty(full, out var x, out var y, out var w, out var h, out var rgb))
                    {
                        var payload = new byte[8 + rgb.Length];
                        BitConverter.GetBytes((ushort)x).CopyTo(payload, 0);
                        BitConverter.GetBytes((ushort)y).CopyTo(payload, 2);
                        BitConverter.GetBytes((ushort)w).CopyTo(payload, 4);
                        BitConverter.GetBytes((ushort)h).CopyTo(payload, 6);
                        Buffer.BlockCopy(rgb, 0, payload, 8, rgb.Length);
                        WriteFrame(stream, 2, payload);
                    }
                    full = false;
                    Thread.Sleep(40);
                }
            }
            catch(Exception)
            {
            }
            try
            {
                client.Close();
            }
            catch(Exception)
            {
            }
        }

        private static void WriteFrame(Stream s, byte type, byte[] payload)
        {
            var header = new byte[5];
            header[0] = type;
            BitConverter.GetBytes(payload.Length).CopyTo(header, 1);
            s.Write(header, 0, header.Length);
            s.Write(payload, 0, payload.Length);
            s.Flush();
        }

        private string StateJson()
        {
            var sb = new StringBuilder();
            sb.Append("{\"t\":\"state\",\"pins\":{");
            for(var i = 0; i < ports.Length; i++)
            {
                if(i > 0)
                {
                    sb.Append(',');
                }
                sb.AppendFormat("\"{0}\":{1}", (char)('A' + i), ports[i].Levels);
            }
            sb.Append("},\"out\":{");
            for(var i = 0; i < ports.Length; i++)
            {
                if(i > 0)
                {
                    sb.Append(',');
                }
                sb.AppendFormat("\"{0}\":{1}", (char)('A' + i), ports[i].OutputPins);
            }
            sb.AppendFormat("}},\"blueBar\":{0},\"lcd\":{{\"on\":{1},\"backlight\":{2},\"width\":{3},\"height\":{4}}}",
                blueBar, lcd.DisplayOn ? "true" : "false", lcd.Backlight ? "true" : "false", lcd.Width, lcd.Height);
            sb.AppendFormat(",\"vtime\":{0}}}", (long)machine.ElapsedVirtualTime.TimeElapsed.TotalMilliseconds);
            return sb.ToString();
        }

        // {"A":[moder,otyper,pupdr,afrl,afrh,extDriven,extLevel],...}
        private string PinConfigJson()
        {
            var sb = new StringBuilder("{");
            for(var i = 0; i < ports.Length; i++)
            {
                if(i > 0)
                {
                    sb.Append(',');
                }
                sb.AppendFormat("\"{0}\":[{1}]", (char)('A' + i), string.Join(",", ports[i].Config));
            }
            return sb.Append('}').ToString();
        }

        private void HandleCommand(string line)
        {
            var parts = line.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            if(parts.Length == 0)
            {
                return;
            }
            try
            {
                switch(parts[0])
                {
                case "full":
                    Interlocked.Exchange(ref fullRequested, 1);
                    break;
                case "reset":
                    machine.RequestReset();
                    break;
                case "pause":
                    machine.Pause();
                    break;
                case "resume":
                    machine.Start();
                    break;
                case "wiegand":
                    var wPulse = ulong.Parse(parts[1]);
                    var wGap = ulong.Parse(parts[2]);
                    var wD0 = ParsePins(parts[3]);
                    var wD1 = ParsePins(parts[4]);
                    var wBits = parts[5];
                    Action wiegand = () => SendWiegand(wD0, wD1, wBits, wPulse, wGap);
                    machine.HandleTimeDomainEvent<Action>(a => a(), wiegand, false);
                    break;
                case "drive":
                case "release":
                    var port = ports[char.ToUpperInvariant(parts[1][0]) - 'A'];
                    var pin = int.Parse(parts[2]);
                    var release = parts[0] == "release";
                    var level = !release && parts.Length > 3 && parts[3] == "1";
                    Action action = () =>
                    {
                        if(release)
                        {
                            port.Release(pin);
                        }
                        else
                        {
                            port.Drive(pin, level);
                        }
                    };
                    machine.HandleTimeDomainEvent<Action>(a => a(), action, false);
                    break;
                }
            }
            catch(Exception e)
            {
                this.Log(LogLevel.Warning, "Bad bridge command '{0}': {1}", line, e.Message);
            }
        }

        private List<KeyValuePair<TibboGPIOPort, int>> ParsePins(string list)
        {
            var result = new List<KeyValuePair<TibboGPIOPort, int>>();
            if(list == "-")
            {
                return result;
            }
            foreach(var item in list.Split(','))
            {
                result.Add(new KeyValuePair<TibboGPIOPort, int>(ports[char.ToUpperInvariant(item[0]) - 'A'], int.Parse(item.Substring(1))));
            }
            return result;
        }

        // Runs on the emulation thread. The lines idle high (driven by the reader): a 0 pulls D0 low, a 1 pulls
        // D1 low, each for pulseUs, with gapUs before the next bit. Timed with the machine's scheduler, so
        // the widths are virtual time whatever the host is doing.
        private void SendWiegand(List<KeyValuePair<TibboGPIOPort, int>> d0, List<KeyValuePair<TibboGPIOPort, int>> d1, string bits, ulong pulseUs, ulong gapUs)
        {
            var started = machine.ElapsedVirtualTime.TimeElapsed;
            Action<int> sendBit = null;
            sendBit = i =>
            {
                if(i >= bits.Length)
                {
                    var took = machine.ElapsedVirtualTime.TimeElapsed - started;
                    this.Log(LogLevel.Info, "Wiegand: {0} bits sent in {1:0.0} ms of virtual time", bits.Length, took.TotalMilliseconds);
                    return;
                }
                var line = bits[i] == '0' ? d0 : d1;
                foreach(var p in line)
                {
                    p.Key.Drive(p.Value, false);
                }
                machine.ScheduleAction(TimeInterval.FromMicroseconds(pulseUs), _ =>
                {
                    foreach(var p in line)
                    {
                        p.Key.Drive(p.Value, true);
                    }
                    machine.ScheduleAction(TimeInterval.FromMicroseconds(gapUs), __ => sendBit(i + 1));
                });
            };
            sendBit(0);
        }

        private volatile bool running;
        private volatile bool pinsDirty;
        private int fullRequested;
        private int blueBar;
        private int listenPort;
        private TcpListener listener;
        private LimitTimer throttleTimer;

        private readonly IMachine machine;
        private readonly Video.TibboSSD1963 lcd;
        private readonly TibboGPIOPort[] ports;
        private readonly int blueBarResetPin, blueBarClockPin, blueBarDataPin;
    }
}

namespace Antmicro.Renode.Peripherals.SPI
{
    using Antmicro.Renode.Peripherals.GPIOPort;

    // AT45 DataFlash. Commands take effect when chip select goes high, as on the real part.
    public class TibboAT45 : ISPIPeripheral
    {
        public TibboAT45(TibboGPIOPort csPort, int csPin, int pageSize = 528, int pageCount = 8192,
            int densityCode = 0xD, int jedecId = 0x1F2701, int pagesPerSector = 128, int sector0aPages = 8, int pagesPerBlock = 8)
        {
            this.csPort = csPort;
            this.csPin = csPin;
            this.pageSize = pageSize;
            this.pageCount = pageCount;
            this.densityCode = densityCode;
            this.jedecId = jedecId;
            this.pagesPerSector = pagesPerSector;
            this.sector0aPages = sector0aPages;
            this.pagesPerBlock = pagesPerBlock;
            binaryPageSize = 1;
            while(binaryPageSize * 2 <= pageSize)
            {
                binaryPageSize *= 2;
            }
            addressShift = 0;
            while((1 << addressShift) < pageSize)
            {
                addressShift++;
            }
            memory = new byte[pageSize * pageCount];
            for(var i = 0; i < memory.Length; i++)
            {
                memory[i] = 0xFF;
            }
            buffers = new[] { new byte[pageSize], new byte[pageSize] };
            csPort.LevelsChanged += OnCs;
            Reset();
        }

        public void Reset()
        {
            selected = !csPort.GetLevel(csPin);
            index = 0;
        }

        public string BackingFile
        {
            get => backingFile;
            set
            {
                backingFile = value;
                if(File.Exists(value))
                {
                    var data = File.ReadAllBytes(value);
                    Array.Copy(data, memory, Math.Min(data.Length, memory.Length));
                }
                else
                {
                    File.WriteAllBytes(value, memory);
                }
                var modeFile = value + ".mode";
                binaryMode = File.Exists(modeFile) && File.ReadAllText(modeFile).Trim() == "binary";
            }
        }

        public bool BinaryMode => binaryMode;

        public byte Transmit(byte data)
        {
            if(!selected)
            {
                return 0xFF;
            }
            var i = index++;
            if(i == 0)
            {
                Begin(data);
                return 0xFF;
            }
            if(i <= headerLength)
            {
                if(i <= 3)
                {
                    address = (address << 8) | data;
                }
                if(i == headerLength)
                {
                    HeaderComplete();
                }
                return 0xFF;
            }
            return Payload(data, i - headerLength - 1);
        }

        public void FinishTransmission()
        {
            Deselect();
        }

        private void OnCs(TibboGPIOPort port, ushort o, ushort n)
        {
            var was = (o & (1 << csPin)) == 0;
            var now = (n & (1 << csPin)) == 0;
            if(now && !was)
            {
                selected = true;
                index = 0;
            }
            else if(!now && was)
            {
                Deselect();
            }
        }

        private void Begin(byte op)
        {
            opcode = op;
            address = 0;
            sequence.Clear();
            sequence.Add(op);
            switch(op)
            {
            case 0x01: case 0x03: case 0x53: case 0x55: case 0x84: case 0x87: case 0x83: case 0x86:
            case 0x88: case 0x89: case 0x82: case 0x85: case 0x81: case 0x50: case 0x7C: case 0x58:
            case 0x59: case 0xD1: case 0xD3: case 0x60: case 0x61:
                headerLength = 3;
                break;
            case 0x0B: case 0xD4: case 0xD6:
                headerLength = 4;
                break;
            case 0x1B:
                headerLength = 5;
                break;
            case 0xE8: case 0xD2:
                headerLength = 7;
                break;
            default:
                headerLength = 0;
                break;
            }
        }

        private void HeaderComplete()
        {
            address &= 0xFFFFFF;
            switch(opcode)
            {
            case 0x01: case 0x03: case 0x0B: case 0x1B: case 0xE8:
                readPointer = Logical(Page(address), ByteInPage(address));
                break;
            case 0xD2:
                pageReadPage = Page(address);
                readByte = ByteInPage(address);
                break;
            case 0x53: case 0x55:
                Array.Copy(memory, PageOffset(Page(address)), buffers[opcode == 0x53 ? 0 : 1], 0, pageSize);
                break;
            case 0x58: case 0x59:
                Array.Copy(memory, PageOffset(Page(address)), buffers[opcode == 0x58 ? 0 : 1], 0, pageSize);
                writeByte = ByteInPage(address);
                break;
            case 0x84: case 0x87: case 0x82: case 0x85: case 0xD1: case 0xD3: case 0xD4: case 0xD6:
                writeByte = (int)(address % (uint)CurrentPageSize);
                readByte = writeByte;
                break;
            }
        }

        private byte Payload(byte data, int n)
        {
            switch(opcode)
            {
            case 0x9F:
                switch(n)
                {
                case 0: return (byte)(jedecId >> 16);
                case 1: return (byte)(jedecId >> 8);
                case 2: return (byte)jedecId;
                default: return 0;
                }
            case 0xD7:
                return (n % 2) == 0 ? Status0 : (byte)0x80;
            case 0x01: case 0x03: case 0x0B: case 0x1B: case 0xE8:
            {
                var v = memory[Physical(readPointer)];
                readPointer = (readPointer + 1) % (CurrentPageSize * pageCount);
                return v;
            }
            case 0xD2:
            {
                var v = memory[PageOffset(pageReadPage) + readByte];
                readByte = (readByte + 1) % CurrentPageSize;
                return v;
            }
            case 0xD1: case 0xD4: case 0xD3: case 0xD6:
            {
                var buf = buffers[(opcode == 0xD1 || opcode == 0xD4) ? 0 : 1];
                var v = buf[readByte];
                readByte = (readByte + 1) % CurrentPageSize;
                return v;
            }
            case 0x84: case 0x87: case 0x82: case 0x85: case 0x58: case 0x59:
            {
                var buf = buffers[(opcode == 0x84 || opcode == 0x82 || opcode == 0x58) ? 0 : 1];
                buf[writeByte] = data;
                writeByte = (writeByte + 1) % CurrentPageSize;
                return 0xFF;
            }
            default:
                if(sequence.Count < 4)
                {
                    sequence.Add(data);
                }
                return 0xFF;
            }
        }

        private void Deselect()
        {
            if(!selected)
            {
                return;
            }
            selected = false;
            if(index == 0)
            {
                return;
            }
            var complete = index > headerLength;
            index = 0;
            if(!complete)
            {
                return;
            }
            switch(opcode)
            {
            case 0x83: case 0x86: case 0x82: case 0x85: case 0x58: case 0x59:
                ProgramPage(Page(address), buffers[(opcode == 0x83 || opcode == 0x82 || opcode == 0x58) ? 0 : 1], true);
                break;
            case 0x88: case 0x89:
                ProgramPage(Page(address), buffers[opcode == 0x88 ? 0 : 1], false);
                break;
            case 0x81:
                ErasePages(Page(address), 1);
                break;
            case 0x50:
            {
                var first = Page(address) - (Page(address) % pagesPerBlock);
                ErasePages(first, pagesPerBlock);
                break;
            }
            case 0x7C:
            {
                var page = Page(address);
                if(page < sector0aPages)
                {
                    ErasePages(0, sector0aPages);
                }
                else if(page < pagesPerSector)
                {
                    ErasePages(sector0aPages, pagesPerSector - sector0aPages);
                }
                else
                {
                    ErasePages(page - (page % pagesPerSector), pagesPerSector);
                }
                break;
            }
            case 0x3D:
                if(sequence.Count == 4 && sequence[1] == 0x2A && sequence[2] == 0x80 && (sequence[3] == 0xA6 || sequence[3] == 0xA7))
                {
                    binaryMode = sequence[3] == 0xA6;
                    if(backingFile != null)
                    {
                        File.WriteAllText(backingFile + ".mode", binaryMode ? "binary" : "default");
                    }
                }
                break;
            case 0xC7:
                if(sequence.Count == 4 && sequence[1] == 0x94 && sequence[2] == 0x80 && sequence[3] == 0x9A)
                {
                    ErasePages(0, pageCount);
                }
                break;
            }
        }

        private void ProgramPage(int page, byte[] buffer, bool erase)
        {
            var offset = PageOffset(page);
            var size = CurrentPageSize;
            for(var i = 0; i < size; i++)
            {
                memory[offset + i] = erase ? buffer[i] : (byte)(memory[offset + i] & buffer[i]);
            }
            PersistRange(offset, pageSize);
        }

        private void ErasePages(int first, int count)
        {
            first = Math.Max(0, Math.Min(first, pageCount));
            count = Math.Min(count, pageCount - first);
            var offset = PageOffset(first);
            for(var i = 0; i < count * pageSize; i++)
            {
                memory[offset + i] = 0xFF;
            }
            PersistRange(offset, count * pageSize);
        }

        private void PersistRange(int offset, int length)
        {
            if(backingFile == null)
            {
                return;
            }
            try
            {
                using(var fs = new FileStream(backingFile, FileMode.OpenOrCreate, FileAccess.Write))
                {
                    fs.Seek(offset, SeekOrigin.Begin);
                    fs.Write(memory, offset, length);
                }
            }
            catch(Exception e)
            {
                this.Log(LogLevel.Warning, "Cannot write {0}: {1}", backingFile, e.Message);
            }
        }

        private int CurrentPageSize => binaryMode ? binaryPageSize : pageSize;

        private byte Status0 => (byte)(0x80 | (densityCode << 2) | (binaryMode ? 1 : 0));

        private int Page(uint addr)
        {
            var page = binaryMode ? (int)(addr / (uint)binaryPageSize) : (int)(addr >> addressShift);
            return page % pageCount;
        }

        private int ByteInPage(uint addr)
        {
            var b = binaryMode ? (int)(addr % (uint)binaryPageSize) : (int)(addr & ((1u << addressShift) - 1));
            return b % CurrentPageSize;
        }

        private int PageOffset(int page)
        {
            return page * pageSize;
        }

        // Linear position in the current addressing mode (pages of CurrentPageSize).
        private int Logical(int page, int byteInPage)
        {
            return page * CurrentPageSize + byteInPage;
        }

        private int Physical(int logical)
        {
            var size = CurrentPageSize;
            return (logical / size) * pageSize + (logical % size);
        }

        private bool selected;
        private int index, headerLength, readPointer, readByte, writeByte, pageReadPage;
        private byte opcode;
        private uint address;
        private bool binaryMode;
        private string backingFile;

        private readonly List<byte> sequence = new List<byte>();
        private readonly byte[] memory;
        private readonly byte[][] buffers;
        private readonly TibboGPIOPort csPort;
        private readonly int csPin, pageSize, pageCount, densityCode, jedecId, pagesPerSector, sector0aPages, pagesPerBlock;
        private readonly int binaryPageSize, addressShift;
    }
}

namespace Antmicro.Renode.Peripherals.Video
{
    using Antmicro.Renode.Peripherals.GPIOPort;

    // SSD1963 on an 8-bit 8080 bus driven through GPIO. Pixels arrive as R,G,B bytes
    // (8-bit pixel data interface). The framebuffer holds what the panel shows.
    public class TibboSSD1963 : IDoubleWordPeripheral, IKnownSize
    {
        // panelRotation: physical mounting of the glass relative to the controller scan (0 or 180).
        public TibboSSD1963(TibboGPIOPort dataPort, int dataOffset,
            TibboGPIOPort wrPort, int wrPin, TibboGPIOPort rdPort, int rdPin,
            TibboGPIOPort dcPort, int dcPin, TibboGPIOPort csPort, int csPin,
            TibboGPIOPort resetPort, int resetPin, TibboGPIOPort blPort, int blPin,
            int width = 320, int height = 240, int panelRotation = 180, bool blActiveLow = true)
        {
            this.blActiveLow = blActiveLow;
            this.dataPort = dataPort;
            this.dataOffset = dataOffset;
            this.wrPort = wrPort;
            this.wrPin = wrPin;
            this.rdPort = rdPort;
            this.rdPin = rdPin;
            this.dcPort = dcPort;
            this.dcPin = dcPin;
            this.csPort = csPort;
            this.csPin = csPin;
            this.resetPort = resetPort;
            this.resetPin = resetPin;
            this.blPort = blPort;
            this.blPin = blPin;
            this.panelRotation = panelRotation;
            Width = width;
            Height = height;
            frame = new int[width * height];

            var watched = new HashSet<TibboGPIOPort> { wrPort, rdPort, resetPort };
            foreach(var p in watched)
            {
                p.LevelsChanged += OnLevels;
            }
            Reset();
        }

        public int Width { get; private set; }

        public int Height { get; private set; }

        public bool DisplayOn { get; private set; }

        public bool Backlight => blPort == null || blPin < 0 || blPort.GetLevel(blPin) != blActiveLow;

        public int PixelsWritten => pixelsWritten;

        // Monitor handle only: the device sits on a small dummy bus window.
        public long Size => 0x100;

        public uint ReadDoubleWord(long offset)
        {
            return 0;
        }

        public void WriteDoubleWord(long offset, uint value)
        {
        }

        public void Reset()
        {
            ControllerReset();
            lock(frameLock)
            {
                Array.Clear(frame, 0, frame.Length);
                MarkAllDirty();
            }
        }

        // Saves the panel image as a binary PPM (P6).
        public void SaveScreenshot(string path)
        {
            using(var fs = new FileStream(path, FileMode.Create))
            {
                var header = Encoding.ASCII.GetBytes(string.Format("P6\n{0} {1}\n255\n", Width, Height));
                fs.Write(header, 0, header.Length);
                TakeDirty(true, out _, out _, out _, out _, out var rgb);
                fs.Write(rgb, 0, rgb.Length);
            }
        }

        // Returns the dirty rectangle (or the whole panel when full is set) as RGB888 rows.
        public bool TakeDirty(bool full, out int x, out int y, out int w, out int h, out byte[] rgb)
        {
            lock(frameLock)
            {
                if(full)
                {
                    MarkAllDirty();
                }
                if(dirtyMaxX < dirtyMinX)
                {
                    x = y = w = h = 0;
                    rgb = null;
                    return false;
                }
                x = dirtyMinX;
                y = dirtyMinY;
                w = dirtyMaxX - dirtyMinX + 1;
                h = dirtyMaxY - dirtyMinY + 1;
                rgb = new byte[w * h * 3];
                var visible = DisplayOn && !sleeping;
                var o = 0;
                for(var row = y; row < y + h; row++)
                {
                    for(var col = x; col < x + w; col++)
                    {
                        var c = visible ? frame[row * Width + col] : 0;
                        if(inverted && visible)
                        {
                            c ^= 0xFFFFFF;
                        }
                        rgb[o++] = (byte)(c >> 16);
                        rgb[o++] = (byte)(c >> 8);
                        rgb[o++] = (byte)c;
                    }
                }
                dirtyMinX = int.MaxValue;
                dirtyMinY = int.MaxValue;
                dirtyMaxX = -1;
                dirtyMaxY = -1;
                return true;
            }
        }

        private void ControllerReset()
        {
            command = 0;
            argIndex = 0;
            addressMode = 0;
            startColumn = 0;
            endColumn = Width - 1;
            startPage = 0;
            endPage = Height - 1;
            column = 0;
            page = 0;
            pixelIndex = 0;
            DisplayOn = false;
            sleeping = false;
            inverted = false;
            readQueue.Clear();
            lock(frameLock)
            {
                MarkAllDirty();
            }
        }

        private void OnLevels(TibboGPIOPort port, ushort o, ushort n)
        {
            if(port == resetPort)
            {
                var rstWas = (o & (1 << resetPin)) != 0;
                var rstNow = (n & (1 << resetPin)) != 0;
                if(rstWas && !rstNow)
                {
                    ControllerReset();
                }
            }
            if(port == wrPort)
            {
                var wrWas = (o & (1 << wrPin)) != 0;
                var wrNow = (n & (1 << wrPin)) != 0;
                if(wrNow && !wrWas && Selected)
                {
                    var b = (byte)(dataPort.Levels >> dataOffset);
                    if(dcPort.GetLevel(dcPin))
                    {
                        Data(b);
                    }
                    else
                    {
                        Command(b);
                    }
                }
            }
            if(port == rdPort)
            {
                var rdWas = (o & (1 << rdPin)) != 0;
                var rdNow = (n & (1 << rdPin)) != 0;
                if(!rdNow && rdWas && Selected)
                {
                    dataPort.DriveMask((ushort)(0xFF << dataOffset), (ushort)(NextReadByte() << dataOffset));
                }
                else if(rdNow && !rdWas)
                {
                    dataPort.ReleaseMask((ushort)(0xFF << dataOffset));
                }
            }
        }

        private bool Selected => !csPort.GetLevel(csPin);

        private void Command(byte c)
        {
            command = c;
            argIndex = 0;
            readQueue.Clear();
            switch(c)
            {
            case 0x01: // soft reset
                ControllerReset();
                break;
            case 0x10: sleeping = true; Refresh(); break;
            case 0x11: sleeping = false; Refresh(); break;
            case 0x20: inverted = false; Refresh(); break;
            case 0x21: inverted = true; Refresh(); break;
            case 0x28: DisplayOn = false; Refresh(); break;
            case 0x29: DisplayOn = true; Refresh(); break;
            case 0x2C: // write memory start
            case 0x2E: // read memory start
                column = startColumn;
                page = startPage;
                pixelIndex = 0;
                break;
            case 0x3C:
            case 0x3E:
                pixelIndex = 0;
                break;
            case 0x0A: readQueue.Enqueue((byte)((sleeping ? 0 : 0x10) | (DisplayOn ? 0x04 : 0) | 0x08)); break;
            case 0x0B: readQueue.Enqueue(addressMode); break;
            case 0x0C: readQueue.Enqueue(pixelFormat); break;
            case 0x0D: readQueue.Enqueue((byte)(inverted ? 0x20 : 0)); break;
            case 0xA1: foreach(var b in new byte[] { 0x01, 0x57, 0x61, 0x01, 0xFF }) readQueue.Enqueue(b); break;
            case 0xE4: readQueue.Enqueue(0x04); break;
            case 0xF1: readQueue.Enqueue(pixelInterface); break;
            }
        }

        private void Data(byte d)
        {
            var i = argIndex++;
            switch(command)
            {
            case 0x2A:
                if(i == 0) startColumn = d << 8;
                else if(i == 1) startColumn |= d;
                else if(i == 2) endColumn = d << 8;
                else if(i == 3) endColumn |= d;
                break;
            case 0x2B:
                if(i == 0) startPage = d << 8;
                else if(i == 1) startPage |= d;
                else if(i == 2) endPage = d << 8;
                else if(i == 3) endPage |= d;
                break;
            case 0x2C:
            case 0x3C:
                pixel[pixelIndex++] = d;
                if(pixelIndex == 3)
                {
                    pixelIndex = 0;
                    PutPixel(pixel[0], pixel[1], pixel[2]);
                }
                break;
            case 0x36:
                addressMode = d;
                break;
            case 0x3A:
                pixelFormat = d;
                break;
            case 0xF0:
                pixelInterface = d;
                break;
            case 0xB0:
                // HDP/VDP (panel size minus one) in bytes 2..5.
                if(i == 2) lcdModeHdp = d << 8;
                else if(i == 3) lcdModeHdp |= d;
                else if(i == 4) lcdModeVdp = d << 8;
                else if(i == 5)
                {
                    lcdModeVdp |= d;
                    Resize(lcdModeHdp + 1, lcdModeVdp + 1);
                }
                break;
            }
        }

        private byte NextReadByte()
        {
            if(command == 0x2E || command == 0x3E)
            {
                // Memory read returns R,G,B for each pixel.
                if(pixelIndex == 0)
                {
                    var c = GetPixel();
                    pixel[0] = (byte)(c >> 16);
                    pixel[1] = (byte)(c >> 8);
                    pixel[2] = (byte)c;
                }
                var v = pixel[pixelIndex++];
                if(pixelIndex == 3)
                {
                    pixelIndex = 0;
                    Advance();
                }
                return v;
            }
            return readQueue.Count > 0 ? readQueue.Dequeue() : (byte)0;
        }

        private void Resize(int w, int h)
        {
            if(w <= 0 || h <= 0 || w > 2048 || h > 2048 || (w == Width && h == Height))
            {
                return;
            }
            lock(frameLock)
            {
                Width = w;
                Height = h;
                frame = new int[w * h];
                MarkAllDirty();
            }
        }

        private bool MapToPanel(int col, int row, out int px, out int py)
        {
            var swap = (addressMode & 0x20) != 0;
            var w = Width;
            var h = Height;
            px = col;
            py = row;
            if((addressMode & 0x40) != 0)
            {
                px = (swap ? h : w) - 1 - px;
            }
            if((addressMode & 0x80) != 0)
            {
                py = (swap ? w : h) - 1 - py;
            }
            if(swap)
            {
                var t = px;
                px = py;
                py = t;
            }
            if((addressMode & 0x02) != 0)
            {
                px = w - 1 - px;
            }
            if((addressMode & 0x01) != 0)
            {
                py = h - 1 - py;
            }
            if(panelRotation == 180)
            {
                px = w - 1 - px;
                py = h - 1 - py;
            }
            return px >= 0 && py >= 0 && px < w && py < h;
        }

        private void PutPixel(byte r, byte g, byte b)
        {
            if(MapToPanel(column, page, out var px, out var py))
            {
                var c = (addressMode & 0x08) != 0 ? (b << 16) | (g << 8) | r : (r << 16) | (g << 8) | b;
                lock(frameLock)
                {
                    frame[py * Width + px] = c;
                    if(px < dirtyMinX) dirtyMinX = px;
                    if(px > dirtyMaxX) dirtyMaxX = px;
                    if(py < dirtyMinY) dirtyMinY = py;
                    if(py > dirtyMaxY) dirtyMaxY = py;
                }
            }
            pixelsWritten++;
            Advance();
        }

        private int GetPixel()
        {
            if(MapToPanel(column, page, out var px, out var py))
            {
                lock(frameLock)
                {
                    var c = frame[py * Width + px];
                    return (addressMode & 0x08) != 0 ? ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF) : c;
                }
            }
            return 0;
        }

        private void Advance()
        {
            column++;
            if(column > endColumn)
            {
                column = startColumn;
                page++;
                if(page > endPage)
                {
                    page = startPage;
                }
            }
        }

        private void Refresh()
        {
            lock(frameLock)
            {
                MarkAllDirty();
            }
        }

        private void MarkAllDirty()
        {
            dirtyMinX = 0;
            dirtyMinY = 0;
            dirtyMaxX = Width - 1;
            dirtyMaxY = Height - 1;
        }

        private byte command, addressMode, pixelFormat = 0x50, pixelInterface;
        private int argIndex, startColumn, endColumn, startPage, endPage, column, page, pixelIndex;
        private int lcdModeHdp, lcdModeVdp;
        private int dirtyMinX, dirtyMinY, dirtyMaxX, dirtyMaxY;
        private int pixelsWritten;
        private bool sleeping, inverted;
        private int[] frame;
        private readonly bool blActiveLow;

        private readonly byte[] pixel = new byte[3];
        private readonly Queue<byte> readQueue = new Queue<byte>();
        private readonly object frameLock = new object();
        private readonly TibboGPIOPort dataPort, wrPort, rdPort, dcPort, csPort, resetPort, blPort;
        private readonly int dataOffset, wrPin, rdPin, dcPin, csPin, resetPin, blPin, panelRotation;
    }
}
