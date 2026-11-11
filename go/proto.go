package dialcache

import (
	"errors"

	"google.golang.org/protobuf/proto"
)

// ProtoCodec stores protobuf messages in the binary wire format. JSONCodec
// cannot decode oneof fields, which encoding/json sees as interfaces. T must be
// a generated message pointer type, such as *pb.User, whose nil value can
// allocate a message. A nil message decodes as an empty one.
type ProtoCodec[T proto.Message] struct{}

func (ProtoCodec[T]) Encode(message T) (Payload, error) {
	raw, err := proto.Marshal(message)
	return Payload{Bytes: raw, Binary: true}, err
}

func (ProtoCodec[T]) Decode(payload Payload) (T, error) {
	var zero T
	// Text that another codec stored can still parse as protobuf wire data.
	if !payload.Binary {
		return zero, errors.New("protobuf payload is not binary")
	}
	message := zero.ProtoReflect().New().Interface().(T)
	if err := proto.Unmarshal(payload.Bytes, message); err != nil {
		return zero, err
	}
	return message, nil
}

// ProtoEqual is an Operation.Comparator for protobuf messages. SemanticEqual
// also compares a message's internal state, which differs between equal
// messages after one of them is marshaled.
func ProtoEqual[T proto.Message](cached, source T) (bool, error) {
	return proto.Equal(cached, source), nil
}
